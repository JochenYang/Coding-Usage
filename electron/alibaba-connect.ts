import { BrowserWindow, session } from 'electron'

/**
 * Alibaba Cloud console login inside the app's own Electron session.
 *
 * Chrome 127+ seals new cookies with app-bound (`v20`) encryption, and the key
 * lives in Chrome's own elevation service — a third-party process cannot read
 * it. CodexBar sidesteps that by reading the macOS Keychain, which has no
 * Windows equivalent.
 *
 * Electron's Chromium writes and owns its own cookie jar, so `cookies.get`
 * returns the session including HttpOnly cookies, whatever Chrome does. The
 * user signs in once in this window and the probe reads that jar afterwards.
 * Chromium stores that jar through OSCrypt (DPAPI on Windows), not as plaintext.
 *
 * Boundaries: the window renders a third-party page with no preload, no Node
 * access and the sandbox on. This module never reads page content, never
 * injects script and never fills a credential. Every navigation — including a
 * server redirect, which `will-navigate` does not cover — is checked against
 * the console hosts, because an unbranded window showing an attacker page would
 * be indistinguishable from the real console.
 */

const PARTITION = 'persist:alibaba-console'
/**
 * Session tickets, per console family. Qwen Cloud issues its own ticket and
 * accepts SSO ones; direct accounts carry `login_aliyunid_ticket`.
 */
const AUTH_TICKETS = ['login_aliyunid_ticket', 'login_qwencloud_ticket', 'qwen_sso_ticket']
const ACCOUNT_NAMES = ['login_aliyunid_pk', 'login_current_pk', 'login_aliyunid']
const ALLOWED_HOSTS = ['aliyun.com', 'alibabacloud.com', 'qwencloud.com']
const CONNECT_TIMEOUT_MS = 5 * 60_000
/** Let the rest of the session land after a relevant cookie appears. */
const SETTLE_MS = 700

/** One entry page per console, so each card can sign in where it reads. */
export type ConsoleTarget = 'coding' | 'qwen' | 'token'

interface TargetSpec {
  entryUrl: string
  /** The URL whose cookie jar proves this console has a session. */
  sessionUrl: string
}

const TARGETS: Record<ConsoleTarget, TargetSpec> = {
  coding: {
    entryUrl: 'https://bailian.console.aliyun.com/',
    sessionUrl: 'https://bailian.console.aliyun.com/',
  },
  // The deep link this used to open answers 404 once signed out, so the window
  // starts at the console root and the cookie lands on the domain either way.
  qwen: {
    entryUrl: 'https://home.qwencloud.com/',
    sessionUrl: 'https://home.qwencloud.com/',
  },
  token: {
    entryUrl: 'https://bailian.console.aliyun.com/',
    sessionUrl: 'https://bailian.console.aliyun.com/',
  },
}

export type ConnectResult =
  | { ok: true }
  | {
      ok: false
      reason: 'cancelled' | 'timeout' | 'no-ticket' | 'unavailable' | 'busy'
      /** What the window saw: a failed load or a blocked navigation, no URLs of ours. */
      detail?: string
    }

function hostnameOfUrl(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return 'unparseable'
  }
}

function isAllowedHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return ALLOWED_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

export function isAllowedConsoleUrl(url: string): boolean {
  try {
    return isAllowedHost(new URL(url).hostname)
  } catch {
    return false
  }
}

export function consoleSession(): Electron.Session {
  return session.fromPartition(PARTITION)
}

/**
 * Whether a cookie set proves a signed-in console session.
 *
 * Qwen Cloud issues its own ticket and accepts SSO ones without an account
 * cookie; the Alibaba consoles also need one of the account cookies. Accepting
 * a locale or account-id cookie alone would treat a signed-out profile as live.
 */
export function hasConsoleTicket(
  cookies: Array<{ name: string }>,
  target: ConsoleTarget = 'coding',
): boolean {
  const names = new Set(cookies.map((cookie) => cookie.name))
  if (!AUTH_TICKETS.some((name) => names.has(name))) return false
  if (target === 'qwen') return true
  return ACCOUNT_NAMES.some((name) => names.has(name))
}

/**
 * Cookies the given request would carry, as one header value.
 *
 * `cookies.get({ url })` applies the browser's own host, path and secure rules,
 * so a cookie for `signin.aliyun.com` is never offered to the data gateway.
 */
export async function readConsoleCookieHeader(
  requestUrl: string,
): Promise<{ ok: true; header: string; detail: string } | { ok: false; reason: string; detail: string }> {
  let direct: Electron.Cookie[]
  let all: Electron.Cookie[]
  try {
    direct = await consoleSession().cookies.get({ url: requestUrl })
    all = await consoleSession().cookies.get({})
  } catch {
    return { ok: false, reason: 'probe-failed', detail: 'jar-unreadable' }
  }

  // Alibaba sets the session ticket on the console host, while the quota RPC
  // runs on a sibling host of the same registrable domain. A host-only ticket
  // therefore never matches the request URL, and the probe would report "no
  // login" right after a successful sign-in. Ticket cookies from the same
  // domain family are added; nothing else is borrowed.
  const family = registrableDomain(hostnameOf(requestUrl))
  const ticketCookies = all.filter(
    (cookie) => /ticket/i.test(cookie.name) && belongsTo(cookie.domain ?? '', family),
  )
  const merged = [...direct]
  for (const cookie of ticketCookies) {
    if (!merged.some((existing) => existing.name === cookie.name)) merged.push(cookie)
  }

  const header = merged
    .filter((cookie) => cookie.value !== '' && /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(cookie.name))
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ')
  const borrowed = merged.length - direct.length
  // A ticket flag, not a value: it separates "no session" from "session sent
  // but rejected", which the card otherwise cannot tell apart.
  const ticket = merged.some((cookie) => /ticket/i.test(cookie.name)) ? 'yes' : 'no'
  // Cookie NAMES only. They are fixed keys (`login_aliyunid_ticket`, `cna`),
  // never account data, and they are the one thing that says which ticket the
  // console actually issued.
  const names = merged
    .map((cookie) => cookie.name)
    .filter((name) => /^[A-Za-z0-9_.-]{1,40}$/.test(name))
    .slice(0, 12)
    .join('|')
  const detail = `jar=${all.length} sent=${merged.length} borrowed=${borrowed} ticket=${ticket} names=${names}`
  return header ? { ok: true, header, detail } : { ok: false, reason: 'no-auth', detail }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/** The last two labels: enough for aliyun.com / alibabacloud.com / qwencloud.com. */
function registrableDomain(host: string): string {
  const labels = host.split('.').filter(Boolean)
  return labels.length <= 2 ? labels.join('.') : labels.slice(-2).join('.')
}

function belongsTo(cookieDomain: string, family: string): boolean {
  const domain = cookieDomain.toLowerCase().replace(/^\./, '')
  return family !== '' && (domain === family || domain.endsWith(`.${family}`))
}

/** Whether the named console's jar already carries a session. */
export async function hasConsoleSession(target: ConsoleTarget = 'coding'): Promise<boolean> {
  try {
    const cookies = await consoleSession().cookies.get({ url: TARGETS[target].sessionUrl })
    return hasConsoleTicket(cookies, target)
  } catch {
    return false
  }
}

export async function clearConsoleSession(): Promise<void> {
  try {
    await consoleSession().clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'cachestorage'] })
  } catch {
    // Nothing to clear is the same as cleared.
  }
}

/** One sign-in window at a time: two would resolve on the same ticket. */
let connectInFlight = false

/**
 * Open one console so the user can sign in. Resolves once that console's
 * session exists, the user closes the window, or the deadline passes.
 *
 * The window keeps waiting after an incomplete pair: closing it on the first
 * ticket would end the flow while the account cookie is still in flight.
 */
export function connectAlibabaConsole(
  parent: BrowserWindow | null,
  target: ConsoleTarget = 'coding',
): Promise<ConnectResult> {
  if (connectInFlight) return Promise.resolve({ ok: false, reason: 'busy' })
  connectInFlight = true

  const spec = TARGETS[target]

  return new Promise<ConnectResult>((resolve) => {
    let settled = false
    let win: BrowserWindow | null = null
    let deadline: NodeJS.Timeout | null = null
    let settleTimer: NodeJS.Timeout | null = null
    /** Why the window never showed the console, if it did not. */
    let failure: string | null = null
    const ses = consoleSession()

    const cleanup = (): void => {
      if (deadline) clearTimeout(deadline)
      if (settleTimer) clearTimeout(settleTimer)
      deadline = null
      settleTimer = null
      ses.cookies.removeListener('changed', onCookie)
      connectInFlight = false
    }

    const finish = (result: ConnectResult): void => {
      if (settled) return
      settled = true
      cleanup()
      if (win && !win.isDestroyed()) win.close()
      resolve(result)
    }

    /** Confirm against the whole jar once it has had a moment to settle. */
    const armSettle = (): void => {
      if (settleTimer) clearTimeout(settleTimer)
      settleTimer = setTimeout(() => {
        settleTimer = null
        void ses.cookies
          .get({ url: spec.sessionUrl })
          .then((cookies) => {
            if (hasConsoleTicket(cookies, target)) finish({ ok: true })
            // Not yet: keep waiting for the next relevant cookie.
          })
          .catch(() => finish({ ok: false, reason: 'unavailable' }))
      }, SETTLE_MS)
    }

    const onCookie = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean): void => {
      if (removed) return
      // Any ticket or account cookie can complete the set, and which name a
      // console issues is not fixed (Qwen has its own and accepts SSO).
      if (!AUTH_TICKETS.includes(cookie.name) && !ACCOUNT_NAMES.includes(cookie.name)) return
      armSettle()
    }

    // Refuse every capability this page could otherwise request silently.
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    ses.setPermissionCheckHandler(() => false)

    try {
      win = new BrowserWindow({
        width: 1280,
        height: 900,
        parent: parent ?? undefined,
        modal: false,
        autoHideMenuBar: true,
        title: 'Alibaba Cloud',
        backgroundColor: '#0b0b12',
        webPreferences: {
          // No preload: this window is a plain third-party page and must never
          // reach our IPC surface.
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          partition: PARTITION,
        },
      })
    } catch {
      // A window that cannot be created must not leave the connect guard stuck.
      finish({ ok: false, reason: 'unavailable' })
      return
    }

    // `will-navigate` covers link clicks and location changes; `will-redirect`
    // covers server 3xx. A redirect that swaps the page for an attacker's login
    // form inside an app-owned window is the whole risk here.
    const guardNavigation = (event: Electron.Event, url: string): void => {
      if (isAllowedConsoleUrl(url)) return
      event.preventDefault()
      // A page that navigates somewhere unexpected is the thing we are blocking,
      // but a blank window is indistinguishable from a hang, so the host is
      // remembered for the card.
      failure = `blocked-nav ${hostnameOfUrl(url)}`
    }
    win.webContents.on('will-navigate', guardNavigation)
    win.webContents.on('will-redirect', guardNavigation)
    win.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
      failure = `load-failed ${errorCode} ${errorDescription}`.slice(0, 120)
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    // A session may already be in the jar (a second card, or a previous
    // attempt), in which case no cookie event fires for it.
    win.webContents.on('did-finish-load', () => armSettle())
    win.on('closed', () => {
      win = null
      // Closing the window after signing in is success, not cancellation: the
      // user may finish before the ticket/account pair is visible, and a
      // console may issue a ticket name this build does not know yet. A ticket
      // cookie is the proof; a merely non-empty jar is not (cna/locale are set
      // without signing in, and would report ok while the card's own
      // hasConsoleSession check says "not connected"). The jar size stays a
      // detail string — cookie values never cross this boundary.
      const why = failure
      void ses.cookies
        .get({ url: spec.sessionUrl })
        .then((cookies) => {
          const known = hasConsoleTicket(cookies, target)
          const anyTicket = cookies.some((cookie) => /ticket/i.test(cookie.name))
          if (known || anyTicket) {
            finish({ ok: true })
            return
          }
          const jar = `jar=${cookies.length}`
          finish({
            ok: false,
            reason: 'cancelled',
            detail: [why, jar].filter(Boolean).join(' · ') || undefined,
          })
        })
        .catch(() => finish({ ok: false, reason: 'cancelled', detail: why ?? undefined }))
    })

    deadline = setTimeout(() => finish({ ok: false, reason: 'timeout' }), CONNECT_TIMEOUT_MS)
    ses.cookies.on('changed', onCookie)

    // Present a plain Chrome UA. Electron's default advertises `Electron/x.y`,
    // which makes some consoles serve their mobile layout in a desktop window.
    const chromeVersion = process.versions.chrome ?? '0'
    win.webContents.setUserAgent(
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`,
    )

    void win.loadURL(spec.entryUrl).catch(() => finish({ ok: false, reason: 'unavailable' }))
  })
}
