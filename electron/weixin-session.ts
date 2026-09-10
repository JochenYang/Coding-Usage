import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ilinkGetUpdates, ilinkPing } from './weixin-ilink'

/**
 * WeChat iLink bot session keeper (main process).
 *
 * iLink's sendmessage answers {ret:-2,errmsg:"prepare failed"} unless the bot
 * session has been "prepared" by a recent authenticated round-trip — in ZCode
 * that is a continuous getupdates long-poll that never stops while the bot is
 * enabled. This desktop app is opened on demand, so the keeper mirrors that
 * contract only for the current run:
 *
 *  - start() spins a background getupdates loop as soon as a token is known
 *  - ensureWarmed() pings getconfig before the first send after a cold start
 *  - on prepare-failed, recover() runs one full getupdates round then the
 *    caller retries the send once
 *  - the get_updates_buf cursor is persisted so restarts do not replay the
 *    whole backlog or confuse the server about client progress
 *
 * Nothing here holds the token on disk — only the opaque cursor does.
 */

type NetFetch = typeof import('electron').net.fetch

/** A successful round within this window means the session is still hot */
const WARM_STALE_MS = 2 * 60_000
/** Long-poll timeout for the background loop (ZCode uses 90s) */
const LOOP_TIMEOUT_MS = 90_000
/** Recovery getupdates: one full idle hold, then give up */
const RECOVER_TIMEOUT_MS = 45_000
/** Fast authenticated ping used before the first send of a cold start */
const PING_TIMEOUT_MS = 15_000
/** How long ensureWarmed waits for an in-flight first loop round */
const WARM_WAIT_MS = 20_000
/** Backoff after a failed loop round before polling again */
const LOOP_ERROR_BACKOFF_MS = 5_000

interface SessionState {
  token: string
  /** Persisted get_updates_buf cursor (opaque server token) */
  buf: string
  /** Epoch ms of the last successful authenticated round-trip */
  lastOkAt: number
  running: boolean
  abort: AbortController | null
  /** In-flight first-success waiter, if any */
  warmWaiters: Array<(ok: boolean) => void>
  /** True while recover() owns the connection — the background loop must wait */
  recovering: boolean
}

let fetcher: NetFetch | null = null
let state: SessionState | null = null
/** Serializes cursor file writes so overlapping loop rounds cannot interleave */
let cursorWrite: Promise<void> = Promise.resolve()

function cursorFile(): string {
  return join(app.getPath('userData'), 'weixin-ilink-cursor.json')
}

function tokenHint(token: string): string {
  // Stable map key without storing any usable token material on disk
  let h = 0
  for (let i = 0; i < token.length; i++) h = (h * 31 + token.charCodeAt(i)) | 0
  return `t${(h >>> 0).toString(16)}`
}

async function loadCursor(token: string): Promise<string> {
  try {
    const raw: unknown = JSON.parse(await readFile(cursorFile(), 'utf8'))
    if (raw && typeof raw === 'object') {
      const rec = raw as Record<string, unknown>
      const v = rec[tokenHint(token)]
      if (typeof v === 'string') return v
    }
  } catch {
    // first run / corrupt file — empty cursor is always safe
  }
  return ''
}

function saveCursor(token: string, buf: string): void {
  cursorWrite = cursorWrite.then(async () => {
    try {
      let map: Record<string, unknown> = {}
      try {
        const raw: unknown = JSON.parse(await readFile(cursorFile(), 'utf8'))
        if (raw && typeof raw === 'object' && !Array.isArray(raw)) map = raw as Record<string, unknown>
      } catch {
        // rebuild
      }
      map[tokenHint(token)] = buf
      await writeFile(cursorFile(), JSON.stringify(map), 'utf8')
    } catch {
      // best-effort: a lost cursor only means the next getupdates starts fresh
    }
  })
}

function markOk(): void {
  if (!state) return
  state.lastOkAt = Date.now()
  const waiters = state.warmWaiters
  state.warmWaiters = []
  for (const w of waiters) w(true)
}

function markWarmFailed(): void {
  if (!state) return
  const waiters = state.warmWaiters
  state.warmWaiters = []
  for (const w of waiters) w(false)
}

/** Bind the net.fetch implementation (called once from registerIpc) */
export function initIlinkSession(fetchImpl: NetFetch): void {
  fetcher = fetchImpl
}

export function isIlinkSessionWarm(): boolean {
  return state != null && state.lastOkAt > 0 && Date.now() - state.lastOkAt < WARM_STALE_MS
}

/**
 * Start (or retarget) the background keep-alive for one bot token.
 * Idempotent for the same token; a different token aborts the old loop first.
 */
export async function startIlinkSession(token: string): Promise<void> {
  if (!fetcher) return
  if (state?.token === token && state.running) return
  await stopIlinkSession()
  const buf = await loadCursor(token)
  const next: SessionState = {
    token,
    buf,
    lastOkAt: 0,
    running: true,
    abort: null,
    warmWaiters: [],
    recovering: false,
  }
  state = next
  void runLoop(next)
}

export async function stopIlinkSession(): Promise<void> {
  const cur = state
  if (!cur) return
  cur.running = false
  cur.abort?.abort()
  cur.abort = null
  markWarmFailed()
  state = null
  // Give the aborted fetch a tick to settle; no need to await the loop body
  await Promise.resolve()
}

/**
 * One fast authenticated ping (POST /getconfig). Cheap enough to run before
 * every cold-start send; success marks the session warm.
 */
export async function pingIlinkSession(token: string): Promise<boolean> {
  if (!fetcher) return false
  try {
    await ilinkPing(fetcher, token, PING_TIMEOUT_MS)
    if (state?.token === token) markOk()
    else if (!state) {
      // Session not looping yet (e.g. send raced hydration) — still remember
      // that this token is currently alive for the warm check below.
      state = {
        token,
        buf: '',
        lastOkAt: Date.now(),
        running: false,
        abort: null,
        warmWaiters: [],
        recovering: false,
      }
    }
    return true
  } catch {
    return false
  }
}

/**
 * Make sure the bot session can accept sendmessage. Never throws.
 *
 * Order: hot session → true; cold → getconfig ping; still cold → wait briefly
 * for the background loop's first round. The long-poll itself is NOT run
 * inline here (it would block an alert for ~30s); recover() owns that path.
 */
export async function ensureIlinkSessionWarm(token: string): Promise<boolean> {
  if (!fetcher) return false
  if (state?.token !== token) {
    await startIlinkSession(token)
  }
  if (isIlinkSessionWarm()) return true
  if (await pingIlinkSession(token)) return true
  // Background loop may already be mid long-poll — wait for its first success
  const cur = state
  if (!cur || !cur.running) return false
  if (cur.lastOkAt > 0 && Date.now() - cur.lastOkAt < WARM_STALE_MS) return true
  return await new Promise<boolean>((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (settled) return
      settled = true
      resolve(ok)
    }
    cur.warmWaiters.push(done)
    setTimeout(() => done(isIlinkSessionWarm()), WARM_WAIT_MS)
  })
}

/**
 * Full recovery after {ret:-2, prepare failed}: one complete getupdates
 * round (the same call ZCode's keep-alive uses) so the platform re-prepares
 * the send path. Returns true when the round succeeded.
 *
 * Aborts any in-flight long-poll first — two concurrent getupdates on the
 * same bot token can confuse the server-side session.
 */
export async function recoverIlinkSession(token: string): Promise<boolean> {
  if (!fetcher) return false
  if (state?.token !== token) {
    await startIlinkSession(token)
  }
  const cur = state
  if (!cur) return false
  // Cancel the background hold so this recovery round owns the connection
  cur.recovering = true
  cur.abort?.abort()
  cur.abort = null
  try {
    const res = await ilinkGetUpdates(fetcher, token, cur.buf, RECOVER_TIMEOUT_MS)
    if (res.nextBuf && res.nextBuf !== cur.buf) {
      cur.buf = res.nextBuf
      saveCursor(token, res.nextBuf)
    }
    markOk()
    return true
  } catch {
    return false
  } finally {
    cur.recovering = false
    // The original runLoop (if any) observes recovering=false and resumes;
    // never spawn a second loop here or two long-polls would race the token.
  }
}

/** Background keep-alive: serial long-polls until stop() aborts the token */
async function runLoop(s: SessionState): Promise<void> {
  if (!fetcher) return
  while (s.running && state === s) {
    // Recover owns the connection — idle briefly instead of stacking polls
    if (s.recovering) {
      await new Promise((r) => setTimeout(r, 200))
      continue
    }
    const abort = new AbortController()
    s.abort = abort
    try {
      const res = await ilinkGetUpdates(fetcher, s.token, s.buf, LOOP_TIMEOUT_MS, abort.signal)
      if (!s.running || state !== s) return
      if (res.nextBuf && res.nextBuf !== s.buf) {
        s.buf = res.nextBuf
        saveCursor(s.token, res.nextBuf)
      }
      markOk()
    } catch {
      if (!s.running || state !== s) return
      // Recover aborted this round on purpose — loop back and wait
      if (s.recovering) continue
      // Transient network / platform blip: rest briefly then poll again.
      // Auth failures also land here; the send path surfaces them.
      await new Promise((r) => setTimeout(r, LOOP_ERROR_BACKOFF_MS))
    }
  }
}
