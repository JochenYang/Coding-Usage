import { useEffect, useState } from 'react'
import { MessageCircle, MessageSquare, MessagesSquare, Send, Share2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { Switch } from '@/components/beui/switch'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { ENC_PREFIX } from '@/lib/storage'
import type { Dict } from '@/i18n/types'
import type { IntegrationsSettings } from '@/types'

export interface IntegrationsPageProps {
  /** Extra classes appended to the page root */
  className?: string
}

type TestState = 'idle' | 'sending' | 'ok' | 'fail'

/** WeChat iLink wizard phases: QR display → activation wait → connected */
type WxPhase = 'idle' | 'qr' | 'activate'

/** Credential fields the drafts object tracks (chat id included for UX, not secret) */
type DraftKey = 'wecomWebhook' | 'feishuWebhook' | 'telegramBotToken' | 'telegramChatId'

type Drafts = Record<DraftKey, string>

interface ChannelField {
  key: DraftKey
  label: string
  placeholder: string
}

/** Channels configured through plain credential inputs (weixin is wizard-driven) */
type InputChannelId = 'wecom' | 'feishu' | 'telegram'

interface ChannelDef {
  id: InputChannelId
  icon: LucideIcon
  name: (t: Dict) => string
  hint: (t: Dict) => string
  fields: (t: Dict) => ChannelField[]
}

/** Static channel catalogue: display order = render order */
const CHANNELS: ChannelDef[] = [
  {
    id: 'wecom',
    icon: MessageSquare,
    name: (t) => t.integrations.chanWecom,
    hint: (t) => t.integrations.chanWecomHint,
    fields: (t) => [{ key: 'wecomWebhook', label: t.integrations.fWebhookUrl, placeholder: t.integrations.phWecom }],
  },
  {
    id: 'feishu',
    icon: MessagesSquare,
    name: (t) => t.integrations.chanFeishu,
    hint: (t) => t.integrations.chanFeishuHint,
    fields: (t) => [{ key: 'feishuWebhook', label: t.integrations.fWebhookUrl, placeholder: t.integrations.phFeishu }],
  },
  {
    id: 'telegram',
    icon: Send,
    name: (t) => t.integrations.chanTelegram,
    hint: (t) => t.integrations.chanTelegramHint,
    fields: (t) => [
      { key: 'telegramBotToken', label: t.integrations.fBotToken, placeholder: t.integrations.phBotToken },
      { key: 'telegramChatId', label: t.integrations.fChatId, placeholder: t.integrations.phChatId },
    ],
  },
]

/** Credential pieces the IPC needs for one channel, built from drafts */
function credFor(channel: InputChannelId, drafts: Drafts): WebhookCredential {
  switch (channel) {
    case 'wecom':
      return { url: drafts.wecomWebhook.trim() }
    case 'feishu':
      return { url: drafts.feishuWebhook.trim() }
    case 'telegram':
      return { token: drafts.telegramBotToken.trim(), chatId: drafts.telegramChatId.trim() }
  }
}

function isCredFilled(channel: InputChannelId, drafts: Drafts): boolean {
  const cred = credFor(channel, drafts)
  switch (channel) {
    case 'wecom':
    case 'feishu':
      return !!cred.url && cred.url.startsWith('https://')
    case 'telegram':
      return !!cred.token && !!cred.chatId
  }
}

/** Hidden while hydration is still decrypting the stored ciphertext */
function plain(value: string): string {
  return value.startsWith(ENC_PREFIX) ? '' : value
}

/** Masked connected-state label for the weixin bot (never print the full id) */
function maskId(id: string): string {
  return id.length > 6 ? `…${id.slice(-6)}` : id
}

/**
 * WeChat iLink bot block: an interactive wizard instead of credential inputs.
 * Scan the QR (main process talks to the iLink platform), then send the bot
 * one message so it learns the push target's user id. The token/user id are
 * persisted through updateSettings as soon as each step lands — the wizard
 * must survive a page change mid-flow.
 */
function WeixinChannelBlock({ onTest }: { onTest: (cred: WebhookCredential) => Promise<WebhookSendResult> }) {
  const t = useT()
  const { settings, updateSettings } = useData()
  const bridge = window.desktopBridge
  const intg = settings.integrations

  const connected =
    !!intg.weixinBotToken && !intg.weixinBotToken.startsWith(ENC_PREFIX) && !!intg.weixinBotUserId

  const [phase, setPhase] = useState<WxPhase>('idle')
  const [qrImg, setQrImg] = useState('')
  const [qrCode, setQrCode] = useState('')
  const [note, setNote] = useState('')
  const [test, setTest] = useState<TestState>('idle')

  // Resume an interrupted activation: the token persisted (QR step done) but
  // the bot was never messaged — or the page reloaded mid-wizard. Skipping
  // the QR step here is what makes a reload mid-activation recoverable.
  useEffect(() => {
    const hook = settings.integrations.weixinBotToken
    if (hook && !hook.startsWith(ENC_PREFIX) && !settings.integrations.weixinBotUserId) {
      setPhase('activate')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- resume runs once on mount
  }, [])

  const beginLogin = async () => {
    if (!bridge) return
    setNote('')
    const res = await bridge.ilinkBegin()
    if (res.error || !res.dataUrl || !res.qrCode) {
      setNote(t.integrations.wxLoginFailed(res.error ?? 'no-qr'))
      return
    }
    setQrImg(res.dataUrl)
    setQrCode(res.qrCode)
    setPhase('qr')
  }

  // Phase 1: poll the QR scan status until the token lands. The endpoint is
  // a server-side long poll (unscanned: ~30s hold, status "wait"), so this is
  // a serial loop — each round-trip IS the pacing, no interval stacking.
  // Timeout/abort errors are transient (server hiccup) and just retry.
  useEffect(() => {
    if (phase !== 'qr' || !bridge || !qrCode) return
    let cancelled = false
    void (async () => {
      while (!cancelled) {
        const res = await bridge.ilinkPoll(qrCode)
        if (cancelled) return
        if (res.status === 'success' && res.botToken) {
          updateSettings({ ...settings, integrations: { ...intg, weixinBotToken: res.botToken } })
          setPhase('activate')
          return
        }
        if (res.status === 'expired') {
          setNote(t.integrations.wxLoginExpired)
          setPhase('idle')
          return
        }
        if (res.status === 'error') {
          setNote(t.integrations.wxLoginFailed(res.message ?? 'error'))
          setPhase('idle')
          return
        }
        // pending/wait → keep long-polling
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wizard phase machine
  }, [phase, qrCode])

  // Phase 2: the bot stays silent until the user messages it; getupdates is
  // the same long-poll shape, so serial rounds again. A timeout error is a
  // normal round-trip ending — retry silently; only real failures show a note
  // (and even then keep polling, the user may just be slow).
  useEffect(() => {
    if (phase !== 'activate' || !bridge) return
    const token = settings.integrations.weixinBotToken
    if (!token || token.startsWith(ENC_PREFIX)) return
    let cancelled = false
    void (async () => {
      while (!cancelled) {
        const res = await bridge.ilinkActivate(token)
        if (cancelled) return
        if (res.userId) {
          updateSettings({
            ...settings,
            integrations: { ...intg, weixinBotUserId: res.userId },
          })
          setPhase('idle')
          return
        }
        if (res.error && !/abort|timeout/i.test(res.error)) {
          setNote(`${t.integrations.wxActivateError}: ${res.error}`)
        }
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- wizard phase machine
  }, [phase, settings.integrations.weixinBotToken])

  const disconnect = () => {
    if (!window.confirm(t.integrations.wxDisconnectConfirm)) return
    updateSettings({ ...settings, integrations: { ...intg, weixinBotToken: '', weixinBotUserId: '' } })
    setPhase('idle')
    setNote('')
  }

  const runTest = async () => {
    const cred = { token: intg.weixinBotToken, userId: intg.weixinBotUserId }
    setTest('sending')
    const res = await onTest(cred)
    setTest(res.ok ? 'ok' : 'fail')
    setNote(res.ok ? '' : t.integrations.testFailed(res.error ?? `HTTP ${res.status}`))
  }

  return (
    <div className="mt-4 border-t border-border/60 pt-4">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
          <MessageCircle className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-foreground">{t.integrations.chanWeixin}</div>
          <p className="mt-0.5 text-[11px] leading-relaxed text-subtle">{t.integrations.chanWeixinHint}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connected && (
            <>
              <button
                type="button"
                onClick={() => void runTest()}
                disabled={test === 'sending'}
                className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                {test === 'sending' ? t.integrations.testing : t.integrations.testPush}
              </button>
              <button
                type="button"
                onClick={disconnect}
                className="rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] text-danger hover:bg-danger/10"
              >
                {t.integrations.wxDisconnect}
              </button>
            </>
          )}
          {!connected && phase === 'idle' && (
            <button
              type="button"
              onClick={() => void beginLogin()}
              className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted"
            >
              {note ? t.integrations.wxLoginAgain : t.integrations.wxLoginBtn}
            </button>
          )}
        </div>
      </div>

      {connected && phase === 'idle' && (
        <p className="mt-1.5 text-[11px] text-success">
          {t.integrations.wxConnected(maskId(intg.weixinBotUserId))}
        </p>
      )}
      {test === 'ok' && <p className="mt-1.5 text-[11px] text-success">{t.integrations.testOk}</p>}

      {phase === 'qr' && (
        <div className="mt-3 flex items-start gap-4 rounded-xl border border-border bg-background p-4">
          <img src={qrImg} alt={t.integrations.wxLoginTitle} className="h-40 w-40 shrink-0 rounded-lg bg-white" />
          <div className="min-w-0 text-xs text-muted-foreground">
            <div className="font-medium text-foreground">{t.integrations.wxLoginTitle}</div>
            <p className="mt-1 leading-relaxed">{t.integrations.wxLoginScan}</p>
          </div>
        </div>
      )}
      {phase === 'activate' && (
        <div className="mt-3 rounded-xl border border-border bg-background p-4 text-xs text-muted-foreground">
          <div className="font-medium text-foreground">{t.integrations.wxActivateTitle}</div>
          <p className="mt-1 leading-relaxed">{t.integrations.wxActivateWait}</p>
        </div>
      )}
      {note && <p className="mt-1.5 text-[11px] text-danger">{note}</p>}
    </div>
  )
}

/**
 * Integrations: outbound channels for the alert engine — WeCom, WeChat (iLink),
 * Feishu/Lark and Telegram. Pushes run in the
 * desktop main process (`webhook:send` IPC), so the whole page is desktop-only.
 */
export function IntegrationsPage({ className }: IntegrationsPageProps) {
  const t = useT()
  const { settings, updateSettings } = useData()
  const bridge = window.desktopBridge
  const intg = settings.integrations

  // Local drafts: writing to settings on every keystroke would fire a
  // persist+encrypt IPC round per character. Saved (and encrypted) explicitly.
  const [drafts, setDrafts] = useState<Drafts>({
    wecomWebhook: plain(intg.wecomWebhook),
    feishuWebhook: plain(intg.feishuWebhook),
    telegramBotToken: plain(intg.telegramBotToken),
    telegramChatId: intg.telegramChatId,
  })
  const [dirty, setDirty] = useState(false)
  const [tests, setTests] = useState<Record<string, { state: TestState; detail: string }>>({})

  // Hydration may land the decrypted credentials after mount; sync them in
  // unless the user has already typed something.
  useEffect(() => {
    if (dirty) return
    setDrafts((d) => ({
      wecomWebhook: plain(intg.wecomWebhook) || d.wecomWebhook,
      feishuWebhook: plain(intg.feishuWebhook) || d.feishuWebhook,
      telegramBotToken: plain(intg.telegramBotToken) || d.telegramBotToken,
      telegramChatId: intg.telegramChatId || d.telegramChatId,
    }))
  }, [intg, dirty])

  if (!bridge) {
    return (
      <div className={cn('space-y-4', className)}>
        <PageHeader title={t.nav.integrations} description={t.integrations.pageDesc} />
        <EmptyState
          icon={<Share2 className="h-6 w-6" />}
          title={t.integrations.desktopOnlyTitle}
          description={t.integrations.desktopOnlyDesc}
        />
      </div>
    )
  }

  const savedOf = (key: DraftKey): string => {
    const v = intg[key]
    return plain(v)
  }
  const saveDisabled = !dirty || (Object.keys(drafts) as DraftKey[]).every((k) => drafts[k].trim() === savedOf(k))

  const save = () => {
    const integrations: IntegrationsSettings = {
      ...intg,
      wecomWebhook: drafts.wecomWebhook.trim(),
      feishuWebhook: drafts.feishuWebhook.trim(),
      telegramBotToken: drafts.telegramBotToken.trim(),
      telegramChatId: drafts.telegramChatId.trim(),
    }
    updateSettings({ ...settings, integrations })
    setDirty(false)
  }

  const sendTest = async (channel: InputChannelId) => {
    if (!isCredFilled(channel, drafts)) {
      setTests((s) => ({ ...s, [channel]: { state: 'fail', detail: t.integrations.needCredential } }))
      return
    }
    setTests((s) => ({ ...s, [channel]: { state: 'sending', detail: '' } }))
    const res = await bridge.webhookSend(channel, credFor(channel, drafts), t.integrations.pushTitle, t.integrations.testMessage)
    setTests((s) => ({
      ...s,
      [channel]: { state: res.ok ? 'ok' : 'fail', detail: res.ok ? '' : (res.error ?? `HTTP ${res.status}`) },
    }))
  }

  const renderChannel = (ch: (typeof CHANNELS)[number]) => {
    const test = tests[ch.id] ?? { state: 'idle' as TestState, detail: '' }
    return (
      <div key={ch.id} className="mt-4 border-t border-border/60 pt-4">
        <div className="flex items-center gap-2.5">
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden>
            <ch.icon className="h-3.5 w-3.5" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-foreground">{ch.name(t)}</div>
            <p className="mt-0.5 text-[11px] leading-relaxed text-subtle">{ch.hint(t)}</p>
          </div>
          <button
            type="button"
            onClick={() => void sendTest(ch.id)}
            disabled={test.state === 'sending'}
            className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {test.state === 'sending' ? t.integrations.testing : t.integrations.testPush}
          </button>
        </div>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
          {ch.fields(t).map((f) => (
            <label key={f.key} className={cn('block min-w-0', ch.fields(t).length > 1 ? 'flex-1' : 'w-full')}>
              <span className="sr-only">{f.label}</span>
              <input
                type="text"
                value={drafts[f.key]}
                onChange={(e) => {
                  setDrafts((d) => ({ ...d, [f.key]: e.target.value }))
                  setDirty(true)
                  setTests((s) => ({ ...s, [ch.id]: { state: 'idle', detail: '' } }))
                }}
                placeholder={f.placeholder}
                title={f.label}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-subtle focus:border-stone-900"
              />
            </label>
          ))}
        </div>
        {test.state === 'ok' && <p className="mt-1.5 text-[11px] text-success">{t.integrations.testOk}</p>}
        {test.state === 'fail' && (
          <p className="mt-1.5 text-[11px] text-danger">{t.integrations.testFailed(test.detail)}</p>
        )}
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', className)}>
      <PageHeader title={t.nav.integrations} description={t.integrations.pageDesc} />

      <section className="rounded-2xl border border-border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-[15px] font-semibold text-foreground">{t.integrations.pushCardTitle}</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {t.integrations.pushCardDesc}
            </p>
          </div>
          <Switch
            checked={intg.alertPush}
            ariaLabel={t.integrations.enablePush}
            onCheckedChange={(on) =>
              updateSettings({ ...settings, integrations: { ...intg, alertPush: on } })
            }
          />
        </div>

        {CHANNELS.filter((ch) => ch.id === 'wecom').map(renderChannel)}
        <WeixinChannelBlock
          onTest={(cred) =>
            bridge.webhookSend('weixin', cred, t.integrations.pushTitle, t.integrations.testMessage)
          }
        />
        {CHANNELS.filter((ch) => ch.id !== 'wecom').map(renderChannel)}

        <div className="mt-5 flex justify-end border-t border-border/60 pt-4">
          <button
            type="button"
            onClick={save}
            disabled={saveDisabled}
            className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
          >
            {t.integrations.save}
          </button>
        </div>
      </section>
    </div>
  )
}
