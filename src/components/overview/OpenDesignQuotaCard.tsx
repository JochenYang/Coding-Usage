import { useEffect, useRef, useState } from 'react'
import { useT } from '@/i18n/useT'
import { formatAgo, formatCountdown } from '@/lib/format'
import { useNowTick } from '@/lib/hooks/use-now-tick'
import { useInView } from '@/lib/hooks/use-in-view'
import { useData } from '@/lib/data-context'
import {
  opendesignWindowLabel,
  summarizeOpendesignQuota,
  type OpendesignQuotaVM,
} from '@/lib/opendesign-quota'
import { ProgressBar } from '@/components/common/ProgressBar'
import { CardWatermark } from '@/components/common/CardWatermark'
import { cn } from '@/lib/cn'
import opendesignLogo from '@/components/logos/opendesign.png'

/**
 * OpenDesign Go subscription quota card. Primary credential: the official
 * device-code login — the card starts it, the user approves
 * open-design.ai/cloud/cli/activate in their browser, and polling stores the
 * control key in the main process (it never crosses IPC). Manual fallback: a
 * Cloud console Cookie pasted into the collapsible panel. The inference API
 * key cannot read quota, so there is no api-key field on purpose.
 */
export function OpenDesignQuotaCard({ className }: { className?: string }) {
  const t = useT()
  const [vm, setVm] = useState<OpendesignQuotaVM | null>(null)
  const [loading, setLoading] = useState(false)
  // Official quota hits the vendor's own endpoint, so it follows the refresh
  // cycle instead of fetching on mount only. The tick moves when a cycle
  // finishes, whatever the provider fetches did.
  const { refreshTick } = useData()
  const { ref: sectionRef, inView } = useInView<HTMLElement>()
  // Saving a credential (or a completed device login) clears the main-process
  // cache and asks for a re-probe; the nonce reruns this effect so the new
  // credential is used immediately with a fresh watchdog.
  const [retryNonce, setRetryNonce] = useState(0)

  useEffect(() => {
    const invalidate = (): void => setRetryNonce((value) => value + 1)
    window.addEventListener('quota:invalidate', invalidate)
    return () => window.removeEventListener('quota:invalidate', invalidate)
  }, [])

  useEffect(() => {
    if (!inView) return
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    /** Set once the live probe has produced a verdict for this run. */
    let refreshed = false
    // Paint the last good reading first (persisted in the main process), then
    // refresh without a visible loading state.
    void bridge
      .quotaSnapshot()
      .then((snapshot) => {
        if (cancelled || refreshed) return
        const stored = snapshot['opendesign']
        if (!stored?.result?.available) return
        const next = summarizeOpendesignQuota(stored.result)
        if (!next.available) return
        setVm({ ...next, fetchedAt: stored.at })
      })
      .catch(() => {
        // No snapshot is the same as an empty one.
      })
    setLoading(true)
    // Race budget covers the two-hop probe (two 15s reads) plus the global
    // concurrency-2 queue wait, in line with the Kimi card's 45s.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = null
    const watchdog = new Promise<never>((_resolve, reject) => {
      watchdogTimer = setTimeout(() => reject(new Error('timeout')), 45_000)
    })
    Promise.race([bridge.opendesignQuota(), watchdog])
      .then((raw) => {
        refreshed = true
        if (cancelled) return
        setVm(summarizeOpendesignQuota(raw))
      })
      .catch(() => {
        refreshed = true
        if (cancelled) return
        // A watchdog timeout must not wipe the snapshot painted above: keep
        // the last reading instead of flashing an unavailable state.
        setVm((prev) => prev ?? summarizeOpendesignQuota({ available: false, reason: 'timeout' }))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      if (watchdogTimer) clearTimeout(watchdogTimer)
    }
  }, [refreshTick, inView, retryNonce])

  const now = useNowTick()
  // Device-code login state (the card drives start → poll → done)
  const [login, setLogin] = useState<{ loginId: number; userCode: string; intervalMs: number; expiresAtMs: number } | null>(null)
  const [starting, setStarting] = useState(false)
  const [loginError, setLoginError] = useState<string | null>(null)
  // Manual cookie fallback, collapsed until asked for
  const [manualOpen, setManualOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasteState, setPasteState] = useState<'idle' | 'saving' | 'saved'>('idle')
  const [pasteError, setPasteError] = useState<string | null>(null)
  const loginIdRef = useRef<number | null>(null)
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const stopLogin = () => {
    const bridge = window.desktopBridge
    const current = loginIdRef.current
    if (bridge && current != null) void bridge.opendesignLoginCancel(current).catch(() => {})
    loginIdRef.current = null
    setLogin(null)
  }

  const startLogin = () => {
    const bridge = window.desktopBridge
    // In-flight guard: loginIdRef is only set once the IPC answers, so a
    // double-click needs its own flag to avoid two sessions and two pages.
    if (!bridge || starting || loginIdRef.current != null) return
    setStarting(true)
    setLoginError(null)
    void bridge
      .opendesignLoginStart()
      .then((started) => {
        // The card may have unmounted while the IPC was in flight; drop the
        // session instead of leaving it to expire in the main process.
        if (!mountedRef.current) {
          if (started.ok) void bridge.opendesignLoginCancel(started.loginId).catch(() => {})
          return
        }
        if (!started.ok) {
          setLoginError(t.manage.opendesignLoginRetry)
          return
        }
        loginIdRef.current = started.loginId
        setLogin({
          loginId: started.loginId,
          userCode: started.userCode,
          intervalMs: started.intervalMs,
          expiresAtMs: started.expiresAtMs,
        })
      })
      .catch(() => {
        if (mountedRef.current) setLoginError(t.manage.opendesignLoginRetry)
      })
      .finally(() => {
        if (mountedRef.current) setStarting(false)
      })
  }

  // Poll while a device session is live: one request at a time, paced by the
  // server's suggested interval, stopped at the code's expiry. Approval stores
  // the control key in the main process and bumps the generation, so the
  // invalidate listener reruns the probe effect with the new credential.
  useEffect(() => {
    if (login == null) return
    const bridge = window.desktopBridge
    if (!bridge) return
    let cancelled = false
    let inFlight = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const tick = () => {
      if (cancelled || inFlight) return
      if (Date.now() >= login.expiresAtMs) {
        stopLogin()
        setLoginError(t.manage.opendesignLoginExpired)
        return
      }
      inFlight = true
      void bridge
        .opendesignLoginPoll(login.loginId)
        .then((result) => {
          if (cancelled) return
          if (result.status === 'approved') {
            stopLogin()
            setRetryNonce((value) => value + 1)
            return
          }
          if (result.status === 'failed') {
            stopLogin()
            setLoginError(
              result.reason === 'expired'
                ? t.manage.opendesignLoginExpired
                : result.reason === 'denied'
                  ? t.manage.opendesignLoginDenied
                  : result.reason === 'cancelled'
                    ? t.manage.opendesignLoginRetry
                    : t.manage.opendesignLoginRetry,
            )
            return
          }
          // pending: schedule the next round only after this one settled
          timer = setTimeout(tick, login.intervalMs)
        })
        .catch(() => {
          // Transport jitter on a single poll is not an auth failure.
          timer = setTimeout(tick, login.intervalMs)
        })
        .finally(() => {
          inFlight = false
        })
    }
    timer = setTimeout(tick, login.intervalMs)
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      // Unmounting the card must not leave a live session (and its device
      // secret) sitting in the main process.
      const current = loginIdRef.current
      if (current != null) void bridge.opendesignLoginCancel(current).catch(() => {})
      loginIdRef.current = null
    }
  }, [login])

  const saveCookie = () => {
    const bridge = window.desktopBridge
    if (!bridge) return
    setPasteState('saving')
    setPasteError(null)
    void bridge
      .opendesignSetCookie(pasteText)
      .then((result) => {
        if (result.ok) {
          setPasteState('saved')
          setPasteText('')
          setManualOpen(false)
          setRetryNonce((value) => value + 1)
        } else {
          setPasteState('idle')
          setPasteError(result.reason ?? 'failed')
        }
      })
      .catch(() => {
        setPasteState('idle')
        setPasteError('failed')
      })
  }

  const clearCredential = () => {
    const bridge = window.desktopBridge
    if (!bridge) return
    void bridge
      .opendesignClearCredential()
      .then(() => {
        setRetryNonce((value) => value + 1)
      })
      .catch(() => {})
  }

  // Only offer "clear" when a credential plausibly exists: an absent probe or
  // a transport failure says nothing about the stored state.
  const hasCredential =
    vm != null &&
    (vm.available ||
      ['reauth', 'no-plan', 'parse-failed', 'malformed-body'].includes(vm.reason ?? '') ||
      (vm.reason ?? '').startsWith('http-'))
  // Error codes from the main-process store, mapped like LocalQuotaCard's.
  const pasteErrorText = (code: string): string => {
    switch (code) {
      case 'invalid':
      case 'too-large':
        return t.manage.opendesignPasteInvalid
      case 'no-keystore':
        return t.manage.pasteErrNoKeystore
      default:
        return t.manage.opendesignSaveFailed
    }
  }

  const unavailableCopy =
    login != null
      ? t.manage.opendesignLoggingIn
      : vm?.reason === 'reauth'
        ? t.manage.opendesignReauth
        : vm?.reason === 'no-auth'
          ? t.manage.opendesignNoAuth
          : vm?.reason === 'no-plan'
            ? t.manage.opendesignNoPlan
            : t.manage.opendesignUnavailable

  // The credential action bar renders in every state: a queued first probe
  // must not keep the user from starting the login, and an active credential
  // still needs its clear/switch entry.

  return (
    <section
      ref={sectionRef}
      className={cn('relative z-0 flex h-full flex-col rounded-2xl border border-border bg-card p-5', className)}
    >
      <CardWatermark icon={<img src={opendesignLogo} alt="" />} />
      <div className="flex items-center gap-2.5">
        <span
          className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted"
          aria-hidden
        >
          <img src={opendesignLogo} className="h-5 w-5 rounded" alt="" />
        </span>
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">OpenDesign</h2>
          <p className="truncate text-[11px] text-subtle">{t.manage.subscriptionTitle}</p>
        </div>
      </div>

      {!vm && (loading || !inView) && <p className="mt-3 text-xs text-subtle">{t.card.loading}</p>}
      {vm != null &&
        (!vm.available ? (
          <p className="mt-3 text-xs leading-relaxed text-subtle">{unavailableCopy}</p>
        ) : (
          <div className="mt-3 space-y-3">
            {vm.windows.map((win, i) => (
              <div key={`${win.id}-${i}`}>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{opendesignWindowLabel(win.id, t)}</span>
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
            {vm.fetchedAt != null && <p className="text-[11px] text-subtle">{formatAgo(vm.fetchedAt, now, t)}</p>}
          </div>
        ))}

      {/* The credential action bar renders in every state: a queued first probe
          must not keep the user from starting the login, and an active
          credential still needs its clear/switch entry. */}
      <div className="mt-3 flex flex-wrap items-center gap-2" data-no-drag>
        {login != null ? (
          <>
            <span className="text-[11px] text-subtle">{t.manage.opendesignLoginCode(login.userCode)}</span>
            <button
              type="button"
              onClick={stopLogin}
              className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted"
            >
              {t.manage.opendesignCancel}
            </button>
          </>
        ) : (
          <>
            {(vm == null || (!vm.available && vm.reason !== 'no-plan')) && (
              // no-plan means the login itself succeeded and the credential is
              // valid — the account simply has no active plan. Offering the
              // login button again would just re-sign the same account.
              <button
                type="button"
                disabled={starting}
                onClick={startLogin}
                className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-muted disabled:opacity-60"
              >
                {t.manage.opendesignLogin}
              </button>
            )}
            <button
              type="button"
              onClick={() => setManualOpen((value) => !value)}
              aria-expanded={manualOpen}
              className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
            >
              {t.manage.opendesignManual}
            </button>
          </>
        )}
        {hasCredential && (
          <button
            type="button"
            onClick={clearCredential}
            className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
          >
            {vm?.available || vm?.reason === 'no-plan'
              ? t.manage.opendesignSignOut
              : t.manage.opendesignClear}
          </button>
        )}
      </div>
      {loginError && <p className="mt-1 break-words text-[11px] text-warning">{loginError}</p>}
      {manualOpen && (
        <div className="mt-3 space-y-1.5" data-no-drag>
          <p className="text-[11px] leading-relaxed text-subtle">{t.manage.opendesignPasteHint}</p>
          <textarea
            value={pasteText}
            onChange={(event) => {
              setPasteText(event.target.value)
              setPasteState('idle')
              setPasteError(null)
            }}
            rows={3}
            spellCheck={false}
            placeholder="cookie: name1=value1; name2=value2"
            className="w-full resize-y rounded-lg border border-border bg-background px-2 py-1.5 font-mono text-[11px] text-foreground outline-none placeholder:text-subtle focus:border-accent"
          />
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={pasteState === 'saving' || pasteText.trim() === ''}
              onClick={saveCookie}
              className="rounded-lg border border-border px-2.5 py-1 text-[11px] hover:bg-muted disabled:opacity-60"
            >
              {pasteState === 'saving' ? t.manage.pasteSaving : t.manage.pasteSave}
            </button>
            {pasteState === 'saved' && <span className="text-[11px] text-success">{t.manage.pasteSaved}</span>}
            {hasCredential && (
              <button
                type="button"
                onClick={clearCredential}
                className="text-[11px] text-subtle underline underline-offset-2 hover:text-muted-foreground"
              >
                {t.manage.opendesignClear}
              </button>
            )}
            {pasteError && <span className="text-[11px] text-warning">{pasteErrorText(pasteError)}</span>}
          </div>
        </div>
      )}
    </section>
  )
}
