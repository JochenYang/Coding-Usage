import { useEffect, useState } from 'react'
import { AlibabaCloud, Cline, Cursor, GithubCopilot, KiloCode, Kiro, Qwen, Windsurf } from '@lobehub/icons'
import { useT } from '@/i18n/useT'
import { formatAgo, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useStripSvgTitle } from '@/lib/hooks/use-strip-svg-title'
import { useData } from '@/lib/data-context'
import {
  summarizeCopilotQuota,
  summarizeCursorQuota,
  type LocalPlanQuotaVM,
  type LocalPlanRaw,
} from '@/lib/local-plan-quota'
import { summarizeSessionQuota } from '@/lib/session-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'

/**
 * Plan-quota card for a client whose allowance is read from its own local
 * login (Cursor, GitHub Copilot). Same contract as the Codex/Claude cards: the
 * credential stays in the main process, only usage numbers arrive here.
 *
 * The source is chosen by `kind` rather than by props so the fetch function
 * identity is stable across renders — an inline callback would restart the
 * request on every render.
 */

export type LocalQuotaKind =
  | 'cursor'
  | 'copilot'
  | 'cline'
  | 'jetbrains'
  | 'windsurf'
  | 'kiro'
  | 'kilo'
  | 'alibaba'
  | 'qwen'
  | 'alitoken'

const SOURCES = {
  cursor: {
    name: 'Cursor',
    logo: <Cursor.Avatar size={16} />,
    // Monochrome glyph for the decorative watermark (see CardWatermark)
    watermark: <Cursor />,
    providerKey: 'cursor',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.cursorUsage(),
    summarize: summarizeCursorQuota,
  },
  copilot: {
    name: 'GitHub Copilot',
    logo: <GithubCopilot.Avatar size={16} />,
    watermark: <GithubCopilot />,
    providerKey: 'copilot',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.copilotUsage(),
    summarize: summarizeCopilotQuota,
  },
  cline: {
    name: 'Cline Pass',
    logo: <Cline.Avatar size={16} />,
    watermark: <Cline />,
    providerKey: 'cline',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.clineQuota(),
    summarize: summarizeSessionQuota,
  },
  jetbrains: {
    name: 'JetBrains AI',
    logo: <span className="text-[11px] font-semibold leading-none text-foreground">JB</span>,
    watermark: <span className="text-7xl font-semibold leading-none">JB</span>,
    providerKey: 'jetbrains',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.jetbrainsQuota(),
    summarize: summarizeSessionQuota,
  },
  windsurf: {
    name: 'Windsurf',
    logo: <Windsurf.Avatar size={16} />,
    watermark: <Windsurf />,
    providerKey: 'windsurf',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.windsurfQuota(),
    summarize: summarizeSessionQuota,
  },
  kiro: {
    name: 'Kiro',
    logo: <Kiro.Avatar size={16} />,
    watermark: <Kiro />,
    providerKey: 'kiro',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.kiroQuota(),
    summarize: summarizeSessionQuota,
  },
  kilo: {
    name: 'Kilo',
    logo: <KiloCode.Avatar size={16} />,
    watermark: <KiloCode />,
    providerKey: 'kilo',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.kiloQuota(),
    summarize: summarizeSessionQuota,
  },
  alibaba: {
    name: 'Alibaba Cloud Coding Plan',
    logo: <AlibabaCloud.Color size={16} />,
    watermark: <AlibabaCloud />,
    providerKey: 'alibaba',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.alibabaCodingPlanQuota(),
    summarize: summarizeSessionQuota,
  },
  qwen: {
    name: 'Qwen Cloud',
    logo: <Qwen.Color size={16} />,
    watermark: <Qwen />,
    providerKey: 'qwen',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.qwenCloudQuota(),
    summarize: summarizeSessionQuota,
  },
  alitoken: {
    name: 'Alibaba Token Plan',
    logo: <AlibabaCloud.Color size={16} />,
    watermark: <AlibabaCloud />,
    providerKey: 'alitoken',
    load: (): Promise<LocalPlanRaw> => window.desktopBridge!.alibabaTokenPlanQuota(),
    summarize: summarizeSessionQuota,
  },
} as const

export function LocalQuotaCard({ kind, className }: { kind: LocalQuotaKind; className?: string }) {
  const t = useT()
  const source = SOURCES[kind]
  const [vm, setVm] = useState<LocalPlanQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Follows the shared refresh cycle like every other subscription card
  const { refreshTick } = useData()
  const brandRef = useStripSvgTitle<HTMLSpanElement>()
  // Only ask for a quota once the card is near the viewport: a dozen cards each
  // firing an IPC on mount meant a dozen probes at once, several of which spawn
  // a PowerShell child.
  const { ref: sectionRef, inView } = useInView<HTMLElement>()
  /** Bumped after a successful Alibaba sign-in so the probe runs again. */
  const [retryNonce, setRetryNonce] = useState(0)
  const [connecting, setConnecting] = useState(false)
  const [connectError, setConnectError] = useState<string | null>(null)
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteState, setPasteState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [pasteError, setPasteError] = useState<string | null>(null)
  /** The probe's own words are a debugging aid, not something to ship open. */
  const [showDetail, setShowDetail] = useState(false)
  // One sign-in serves all three Alibaba cards; each card re-probes when any of
  // them reports a finished sign-in.
  useEffect(() => {
    const handler = (): void => setRetryNonce((value) => value + 1)
    window.addEventListener('quota:invalidate', handler)
    return () => window.removeEventListener('quota:invalidate', handler)
  }, [])

  useEffect(() => {
    if (!inView) return
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    /** Set once the live probe has produced a verdict for this run. */
    let refreshed = false
    // Paint the last good reading first (persisted in the main process), then
    // refresh without a visible loading state. Only a card with nothing stored
    // shows a spinner.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        // A snapshot that arrives after the probe must not rewind the card to
        // older numbers.
        if (cancelled || refreshed) return
        const stored = snapshot[source.providerKey]
        if (!stored?.result?.available) return
        const vm = source.summarize(stored.result)
        // A stored body this build can no longer decode is not a reading.
        if (!vm.available) return
        setVm({ ...vm, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), 15_000)
    })
    Promise.race([source.load(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm({ ...source.summarize(raw), fetchedAt: Date.now() })
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        setVm({ ...source.summarize({ available: false, reason: 'timeout' }), fetchedAt: Date.now() })
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  }, [refreshTick, source, inView, retryNonce])

  const now = useNowTick()
  const emptyText = {
    cursor: t.manage.cursorNoAuth,
    copilot: t.manage.copilotNoAuth,
    cline: vm?.reason === 'reauth' ? t.manage.clineReauth : t.manage.clineNoAuth,
    jetbrains: t.manage.jetbrainsNoAuth,
    windsurf: t.manage.windsurfNoAuth,
    kiro: vm?.reason === 'reauth' ? t.manage.kiroReauth : t.manage.kiroNoAuth,
    kilo: vm?.reason === 'reauth' ? t.manage.kiloReauth : t.manage.kiloNoAuth,
    alibaba: vm?.reason === 'reauth' ? t.manage.aliReauth : t.manage.aliNoAuth,
    qwen: vm?.reason === 'reauth' ? t.manage.aliReauth : t.manage.qwenNoAuth,
    alitoken: vm?.reason === 'reauth' ? t.manage.aliReauth : t.manage.alitokenNoAuth,
  }[kind]
  // A signed-in account without a subscription is a real answer, not a failure.
  const emptyCopy = vm?.reason === 'no-plan' ? t.manage.alibabaNoPlan : emptyText
  // A sealed Cursor token cannot be read by this app at all: point at the
  // manual path instead of telling the user to log in again (which would not help).
  const sealed = vm?.reason === 'sealed-token' && kind === 'cursor'
  // The three Alibaba cards share one in-app console session; a browser cookie
  // is never available for them on Windows, so this is their only sign-in path.
  const canConnectConsole =
    (kind === 'alibaba' || kind === 'qwen' || kind === 'alitoken') && vm?.reason !== 'no-plan'
  const consoleTarget = kind === 'qwen' ? 'qwen' : kind === 'alitoken' ? 'token' : 'coding'
  /** The storage key for a pasted request (the connect window names differ). */
  const pastedTarget = kind === 'qwen' ? 'qwen' : kind === 'alitoken' ? 'alitoken' : 'alibaba'
  /** Parser codes are not user copy; each one needs a sentence. */
  const pasteErrorText = (code: string): string => {
    switch (code) {
      case 'no-cookie':
        return t.manage.pasteErrNoCookie
      case 'host-not-allowed':
      case 'not-https':
        return t.manage.pasteErrHost
      case 'unknown-console':
        return t.manage.pasteErrConsole
      case 'wrong-console':
        return t.manage.pasteErrWrongConsole
      case 'no-keystore':
        return t.manage.pasteErrNoKeystore
      default:
        return t.manage.pasteErrParse
    }
  }

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      {/* Monogram-free: the mono glyph needs no sizing or tint override */}
      <CardWatermark icon={source.watermark} />
      <div className="flex items-center gap-2.5">
        <span
          ref={brandRef}
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted [&>svg]:h-5 [&>svg]:w-5"
          aria-hidden
        >
          {source.logo}
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <h2 className="text-sm font-semibold text-foreground">{source.name}</h2>
            {vm?.available && vm.plan && (
              <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[10px] text-subtle">
                {vm.plan}
              </span>
            )}
          </div>
          <p className="text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) ? (
        <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>
      ) : !vm?.available ? (
        <div className="mt-3 space-y-2">
          <p className="text-xs leading-relaxed text-subtle">
            {sealed ? t.manage.cursorSealed : emptyCopy}
            {vm?.reason === 'cookie-app-bound' ? ` ${t.manage.aliCookieAppBound}` : null}
            {vm?.reason === 'unsupported-platform' ? ` ${t.manage.quotaUnsupportedPlatform}` : null}
          </p>
          {vm?.reason && (
            <div className="space-y-1">
              <button
                type="button"
                onClick={() => setShowDetail((value) => !value)}
                className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
                aria-expanded={showDetail}
              >
                {t.manage.detailToggle}
              </button>
              {showDetail && (
                <p className="break-words text-[11px] leading-relaxed text-subtle opacity-80">
                  {vm.reason}
                  {vm.detail ? ` · ${vm.detail}` : ''}
                </p>
              )}
            </div>
          )}
          {canConnectConsole && (
            <>
              <p className="text-[11px] leading-relaxed text-subtle">{t.manage.alibabaConnectHint}</p>
              <button
                type="button"
                disabled={connecting}
                onClick={() => {
                  const bridge = window.desktopBridge
                  if (!bridge) return
                  setConnecting(true)
                  setConnectError(null)
                  void bridge
                    .alibabaConnect(consoleTarget)
                    .then((result) => {
                      if (result.ok) {
                        // Every Alibaba card shares this session.
                        window.dispatchEvent(new Event('quota:invalidate'))
                        return
                      }
                      // A cancelled click is silence; anything the window ran
                      // into is worth showing, including a blank page.
                      const text = [result.reason, result.detail].filter(Boolean).join(' · ')
                      if (text) setConnectError(text)
                    })
                    .catch(() => setConnectError('connect-failed'))
                    .finally(() => setConnecting(false))
                }}
                className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              >
                {connecting ? t.manage.alibabaConnecting : t.manage.alibabaConnect}
              </button>
              {connectError && (
                <p className="break-words text-[11px] leading-relaxed text-warning">{connectError}</p>
              )}
              {/* The console's own request is the only variant the gateway
                  accepts; see pasted-requests.ts. */}
              <button
                type="button"
                onClick={() => setPasteOpen((value) => !value)}
                className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
                aria-expanded={pasteOpen}
              >
                {t.manage.pasteCurl}
              </button>
              {pasteOpen && (
                <div className="space-y-1.5" data-no-drag>
                  <p className="text-[11px] leading-relaxed text-subtle">{t.manage.pasteCurlHint}</p>
                  {/* Placeholder stays literal: it is an example, not copy. */}
                  <textarea
                    value={pasteText}
                    onChange={(event) => {
                      setPasteText(event.target.value)
                      setPasteState('idle')
                      setPasteError(null)
                    }}
                    rows={4}
                    spellCheck={false}
                    placeholder="curl 'https://bailian-cs.console.aliyun.com/data/api.json?...' -H 'cookie: ...'"
                    className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none placeholder:text-subtle focus:border-accent"
                  />
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={pasteState === 'saving' || pasteText.trim() === ''}
                      onClick={() => {
                        const bridge = window.desktopBridge
                        if (!bridge) return
                        setPasteState('saving')
                        setPasteError(null)
                        void bridge
                          .pastedRequestSet(pastedTarget, pasteText)
                          .then((result) => {
                            if (result.ok) {
                              setPasteState('saved')
                              setPasteText('')
                              window.dispatchEvent(new Event('quota:invalidate'))
                            } else {
                              setPasteState('idle')
                              setPasteError(result.reason ?? 'failed')
                            }
                          })
                          .catch(() => {
                            setPasteState('idle')
                            setPasteError('failed')
                          })
                      }}
                      className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-60"
                    >
                      {pasteState === 'saving' ? t.manage.pasteSaving : t.manage.pasteSave}
                    </button>
                    {pasteState === 'saved' && (
                      <span className="text-[11px] text-success">{t.manage.pasteSaved}</span>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        const bridge = window.desktopBridge
                        if (!bridge) return
                        void bridge.pastedRequestClear(pastedTarget).then(() => {
                          setPasteText('')
                          setPasteState('idle')
                          window.dispatchEvent(new Event('quota:invalidate'))
                        })
                      }}
                      className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
                    >
                      {t.manage.pasteClear}
                    </button>
                  </div>
                  {pasteError && <p className="text-[11px] text-warning">{pasteErrorText(pasteError)}</p>}
                </div>
              )}
            </>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {vm.windows.map((win) => (
            <div key={win.id}>
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{t.windows[win.id]}</span>
                <span
                  className={cn(
                    'tabular-nums',
                    win.percent >= 100 ? 'text-danger' : win.percent >= 70 ? 'text-warning' : 'text-foreground',
                  )}
                >
                  {Math.round(win.percent)}%
                </span>
              </div>
              <ProgressBar percent={win.percent} size="sm" className="mt-1.5" />
              {win.resetsAt != null && (
                <p className="mt-1 text-[11px] text-subtle">{formatCountdown(win.resetsAt, now, t)}</p>
              )}
            </div>
          ))}
          {vm.topUpCredits != null && (
            <p className="text-xs text-muted-foreground">{t.manage.jetbrainsTopUp(vm.topUpCredits.toFixed(2))}</p>
          )}
          {vm.stale && <p className="text-[11px] leading-relaxed text-subtle">{t.manage.windsurfStale}</p>}
          {vm.fetchedAt != null && (
            <p className="text-[11px] text-subtle">{formatAgo(vm.fetchedAt, now, t)}</p>
          )}
          {/* Once a pasted request works the card leaves the empty state, so the
              only way to remove that stored session lives here. */}
          {canConnectConsole && (
            <button
              type="button"
              onClick={() => {
                const bridge = window.desktopBridge
                if (!bridge) return
                void bridge
                  .pastedRequestClear(pastedTarget)
                  .then(() => window.dispatchEvent(new Event('quota:invalidate')))
                  .catch(() => undefined)
              }}
              className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
            >
              {t.manage.pasteClear}
            </button>
          )}
        </div>
      )}
    </section>
  )
}
