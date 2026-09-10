import { useEffect, useState } from 'react'
import { ChevronDown, MessageCircle, MessageSquare, MessagesSquare, Send, Share2 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { PageHeader } from '@/components/common/PageHeader'
import { EmptyState } from '@/components/common/EmptyState'
import { Switch } from '@/components/beui/switch'
import { ConfirmDialog } from '@/components/beui/confirm-dialog'
import { cn } from '@/lib/cn'
import { useT } from '@/i18n/useT'
import { useData } from '@/lib/data-context'
import { ENC_PREFIX } from '@/lib/storage'
import { unreadCount } from '@/lib/alerts'
import { loadPushLog, logPushAttempt, clearPushLog, configuredChannels, type PushLogEntry } from '@/lib/alert-push'
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
  // Connection check (token alive vs dead), separate from the send test so
  // the UI can tell "re-login needed" apart from "payload rejected"
  const [verify, setVerify] = useState<TestState>('idle')
  const [verifyDetail, setVerifyDetail] = useState('')
  // Raw failure detail of the last test send (for the copy button); the
  // visible note is the localized sentence wrapping this detail.
  const [testDetail, setTestDetail] = useState('')
  const [copied, setCopied] = useState(false)

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

  // Disconnect guard state lives with its dialog logic (not the test-send
  // states above) so the two features stay separately readable
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const disconnect = () => {
    // Clearing the token flips the data-context keep-alive effect, which
    // calls ilinkSessionStop; do it explicitly too so the loop dies even if
    // the settings write is delayed.
    void window.desktopBridge?.ilinkSessionStop()
    updateSettings({ ...settings, integrations: { ...intg, weixinBotToken: '', weixinBotUserId: '' } })
    setPhase('idle')
    setNote('')
    setConfirmDisconnect(false)
  }

  const runVerify = async () => {
    if (!bridge) return
    setVerify('sending')
    setVerifyDetail('')
    try {
      const res = await bridge.ilinkCheck(intg.weixinBotToken)
      setVerify(res.ok ? 'ok' : 'fail')
      if (!res.ok) setVerifyDetail(res.error ?? '')
    } catch (e) {
      setVerify('fail')
      setVerifyDetail(e instanceof Error ? e.message : String(e))
    }
  }

  const runTest = async () => {
    const cred = { token: intg.weixinBotToken, userId: intg.weixinBotUserId }
    setTest('sending')
    setCopied(false)
    const res = await onTest(cred)
    const detail = res.ok ? '' : (res.error ?? `HTTP ${res.status}`)
    setTest(res.ok ? 'ok' : 'fail')
    setTestDetail(detail)
    setNote(res.ok ? '' : t.integrations.testFailed(detail))
    logPushAttempt('weixin', res.ok, res.ok ? undefined : detail)
  }

  const copyDetail = () => {
    if (!testDetail) return
    try {
      void navigator.clipboard?.writeText(testDetail)?.then(() => setCopied(true))
    } catch {
      // clipboard unavailable — the detail stays visible for manual copying
    }
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
                onClick={() => void runVerify()}
                disabled={verify === 'sending' || test === 'sending'}
                className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
              >
                {verify === 'sending' ? t.integrations.wxVerifying : t.integrations.wxVerify}
              </button>
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
                onClick={() => setConfirmDisconnect(true)}
                className="rounded-lg border border-danger/40 px-2.5 py-1 text-[11px] text-danger hover:bg-danger/10"
              >
                {t.integrations.wxDisconnect}
              </button>
              <ConfirmDialog
                open={confirmDisconnect}
                title={t.integrations.wxDisconnect}
                description={t.integrations.wxDisconnectConfirm}
                confirmText={t.integrations.wxDisconnect}
                cancelText={t.common.cancel}
                danger
                onConfirm={disconnect}
                onCancel={() => setConfirmDisconnect(false)}
              />
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
      {verify === 'ok' && <p className="mt-1.5 text-[11px] text-success">{t.integrations.wxVerifyOk}</p>}
      {verify === 'fail' && (
        <p className="mt-1.5 text-[11px] text-danger">
          {t.integrations.testFailed(verifyDetail || 'check')}
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
      {note && (
        <p className="mt-1.5 text-[11px] text-danger">
          {note}
          {test === 'fail' && testDetail && (
            <button
              type="button"
              onClick={copyDetail}
              className="ml-2 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground hover:bg-muted"
            >
              {copied ? t.integrations.copied : t.integrations.copyError}
            </button>
          )}
        </p>
      )}
      {(test === 'fail' || verify === 'fail') && (
        <p className="mt-1 text-[11px] text-subtle">
          {/-2/.test(testDetail || verifyDetail)
            ? t.integrations.wxStaleHint
            : t.integrations.wxReloginHint}
        </p>
      )}
    </div>
  )
}

/** Compact MM-DD HH:mm stamp shared by the status line and the history list */
function stamp(at: number): string {
  const d = new Date(at)
  const p = (n: number): string => `${n}`.padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Push health summary at the top of the card: it closes the three silent
 * traps (testing drafts that were never saved, master switch off, zero
 * usable channels) and shows the unread count plus the last attempt outcome
 * so "alerts never arrive" is diagnosable in one glance.
 */
function PushStatusBlock({ dirty }: { dirty: boolean }) {
  const t = useT()
  const { settings, alerts } = useData()
  const intg = settings.integrations
  const usable = configuredChannels(intg)
  const unread = unreadCount(alerts)
  const last = loadPushLog().at(-1)
  return (
    <div className="mt-3 space-y-1 rounded-xl border border-border/60 bg-background px-3 py-2 text-[11px] leading-relaxed">
      {dirty && <p className="text-warning">{t.integrations.pushStatusDirty}</p>}
      {!intg.alertPush && usable.length > 0 && (
        <p className="text-warning">{t.integrations.pushStatusOff}</p>
      )}
      {intg.alertPush && usable.length === 0 && (
        <p className="text-danger">{t.integrations.pushStatusNoChannel}</p>
      )}
      <p className="text-muted-foreground">
        {t.integrations.pushStatusReady(usable.length)} · {t.integrations.pushStatusUnread(unread)}
        {last != null && (
          <>
            {' · '}
            {last.ok ? (
              <span className="text-success">{t.integrations.pushStatusLastOk(stamp(last.at))}</span>
            ) : (
              <span className="text-danger">
                {t.integrations.pushStatusLastFail(last.error || '')} · {stamp(last.at)}
              </span>
            )}
          </>
        )}
        {last == null && <span className="text-subtle"> · {t.integrations.pushStatusNever}</span>}
      </p>
    </div>
  )
}
/**
 * Recent push attempts (manual tests + background auto pushes), newest first.
 * Read straight from the persisted log on every render so entries written by
 * a just-finished test send appear immediately; auto pushes surface on the
 * next render. Without this list a background failure is completely silent.
 */
function PushHistoryBlock() {
  const t = useT()
  const [collapsed, setCollapsed] = useState(false)
  // Bump to re-render after clearing (the log itself lives in localStorage;
  // fresh test sends re-render the page through their own state anyway)
  const [, setTick] = useState(0)
  const log = loadPushLog().slice(-5).reverse()
  if (log.length === 0) return null
  const channelName = (c: PushLogEntry['channel']): string => {
    switch (c) {
      case 'wecom':
        return t.integrations.chanWecom
      case 'feishu':
        return t.integrations.chanFeishu
      case 'telegram':
        return t.integrations.chanTelegram
      case 'weixin':
        return t.integrations.chanWeixin
    }
  }
  return (
    <div className="mt-4 border-t border-border/60 pt-3">
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          aria-label={t.integrations.pushHistoryTitle}
          aria-expanded={!collapsed}
          className="rounded p-0.5 text-subtle transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', collapsed && '-rotate-90')} />
        </button>
        <div className="min-w-0 flex-1 text-xs font-medium text-foreground">
          {t.integrations.pushHistoryTitle} · {log.length}
        </div>
        <button
          type="button"
          onClick={() => {
            clearPushLog()
            setTick((x) => x + 1)
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-subtle transition-colors hover:bg-muted hover:text-foreground"
        >
          {t.integrations.pushHistoryClear}
        </button>
      </div>
      {!collapsed && (
        <ul className="mt-1.5 space-y-1">
          {log.map((e, i) => (
            <li
              key={`${e.at}-${i}`}
              className="flex items-baseline gap-2 text-[11px] text-muted-foreground"
            >
              <span className="shrink-0 tabular-nums text-subtle">{stamp(e.at)}</span>
              <span className="shrink-0">{channelName(e.channel)}</span>
              {e.ok ? (
                <span className="shrink-0 text-success">{t.integrations.pushHistoryOk}</span>
              ) : (
                <span className="min-w-0 flex-1 truncate text-danger">
                  {e.error ? t.integrations.testFailed(e.error) : t.integrations.pushHistoryFail}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
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
    const detail = res.ok ? '' : (res.error ?? `HTTP ${res.status}`)
    setTests((s) => ({
      ...s,
      [channel]: { state: res.ok ? 'ok' : 'fail', detail },
    }))
    logPushAttempt(channel, res.ok, res.ok ? undefined : detail)
  }

  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const copyText = (text: string, key: string) => {
    try {
      void navigator.clipboard?.writeText(text)?.then(() => setCopiedKey(key))
    } catch {
      // clipboard unavailable — the detail stays visible for manual copying
    }
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
                  setCopiedKey(null)
                  setTests((s) => ({ ...s, [ch.id]: { state: 'idle', detail: '' } }))
                }}
                placeholder={f.placeholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full rounded-lg border border-border bg-card px-3 py-1.5 font-mono text-xs text-foreground outline-none placeholder:text-subtle focus:border-accent"
              />
            </label>
          ))}
        </div>
        {test.state === 'ok' && <p className="mt-1.5 text-[11px] text-success">{t.integrations.testOk}</p>}
        {test.state === 'fail' && (
          <p className="mt-1.5 text-[11px] text-danger">
            {t.integrations.testFailed(test.detail)}
            {test.detail && (
              <button
                type="button"
                onClick={() => copyText(test.detail, ch.id)}
                className="ml-2 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground hover:bg-muted"
              >
                {copiedKey === ch.id ? t.integrations.copied : t.integrations.copyError}
              </button>
            )}
          </p>
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

        <PushStatusBlock dirty={dirty} />

        {CHANNELS.filter((ch) => ch.id === 'wecom').map(renderChannel)}
        <WeixinChannelBlock
          onTest={(cred) =>
            bridge.webhookSend('weixin', cred, t.integrations.pushTitle, t.integrations.testMessage)
          }
        />
        {CHANNELS.filter((ch) => ch.id !== 'wecom').map(renderChannel)}

        <PushHistoryBlock />

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
