import { app } from 'electron'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ilinkGetUpdates } from './weixin-ilink'

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
 *  - ensureWarmed() waits for that loop's request to sit with the server,
 *    which is the signal that keeps the session fresh (a short config ping
 *    does NOT — it answers happily against a stale session, which is exactly
 *    how a cold start used to collect {ret:-2,prepare failed} on its first
 *    send)
 *  - on prepare-failed, recover() re-issues the poll and lets the caller
 *    retry; an idle hold counts, because the server holding our authenticated
 *    poll is the same state ZCode's always-on loop leaves it in
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
/**
 * Recovery getupdates: one idle hold, then let the caller retry. The hold is
 * the point — the server keeps an idle poll open, so the round rarely
 * "completes" and waiting the full loop timeout would only delay the retry.
 */
const RECOVER_TIMEOUT_MS = 15_000
/** How long ensureWarmed waits for the loop's poll to settle with the server */
const WARM_WAIT_MS = 20_000
/**
 * A poll the server has been holding this long counts as "the session is
 * fresh": an idle getupdates is answered by holding it open, so a request
 * still in flight is evidence the platform sees this client polling.
 */
const POLL_SETTLE_MS = 2_000
/** Poll interval while waiting for the loop to settle */
const WARM_POLL_MS = 250
/** Backoff after a failed loop round before polling again */
const LOOP_ERROR_BACKOFF_MS = 5_000

interface SessionState {
  token: string
  /** Persisted get_updates_buf cursor (opaque server token) */
  buf: string
  /** Epoch ms of the last successful authenticated round-trip */
  lastOkAt: number
  /** Epoch ms the in-flight getupdates was dispatched; 0 when none is in flight */
  pollStartedAt: number
  running: boolean
  abort: AbortController | null
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
}

/** Bind the net.fetch implementation (called once from registerIpc) */
export function initIlinkSession(fetchImpl: NetFetch): void {
  fetcher = fetchImpl
}

export function isIlinkSessionWarm(): boolean {
  return state != null && state.lastOkAt > 0 && Date.now() - state.lastOkAt < WARM_STALE_MS
}

/**
 * True once the background loop's poll has been in flight long enough that the
 * server must be holding it (an idle getupdates is answered by holding the
 * request open, not by a fast error). This is what tells us the platform is
 * currently prepared to accept sendmessage from this client.
 */
function isPollSettled(): boolean {
  return (
    state != null &&
    state.pollStartedAt > 0 &&
    Date.now() - state.pollStartedAt >= POLL_SETTLE_MS
  )
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
    pollStartedAt: 0,
    running: true,
    abort: null,
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
  state = null
  // Give the aborted fetch a tick to settle; no need to await the loop body
  await Promise.resolve()
}

/**
 * Make sure the bot session can accept sendmessage. Never throws.
 *
 * The platform prepares the send path while an authenticated getupdates poll
 * is live, so "warm" means either a recent completed round or a poll that has
 * been in flight long enough for the server to be holding it. The long-poll
 * result is often never observed (the server holds it until the next message),
 * which is why the in-flight state is treated as the success signal instead of
 * waiting for a round to return.
 */
export async function ensureIlinkSessionWarm(token: string): Promise<boolean> {
  if (!fetcher) return false
  if (state?.token !== token) {
    await startIlinkSession(token)
  }
  if (isIlinkSessionWarm() || isPollSettled()) return true
  // Fresh loop: its first poll needs a moment to reach the server. Wait for
  // the settle window rather than the round's completion — an idle round only
  // ends when the server lets go of it.
  const deadline = Date.now() + WARM_WAIT_MS
  while (Date.now() < deadline) {
    if (isIlinkSessionWarm() || isPollSettled()) return true
    if (!state?.running) return false
    await new Promise((r) => setTimeout(r, WARM_POLL_MS))
  }
  return isIlinkSessionWarm() || isPollSettled()
}

/**
 * Recovery after {ret:-2, prepare failed}: re-issue the authenticated poll so
 * the platform re-prepares the send path, then let the caller retry.
 *
 * A round that ends by timeout/abort has still done its job — the server held
 * our poll for the whole window, which is the prepared state. Treating that
 * hold as failure (the previous behaviour) made every cold-start recovery
 * report "failed" and the retry never happened.
 */
export async function recoverIlinkSession(token: string): Promise<boolean> {
  if (!fetcher) return false
  if (state?.token !== token) {
    await startIlinkSession(token)
  }
  const cur = state
  if (!cur) return false
  // A poll the server is already holding means the session is prepared
  if (isPollSettled()) return true
  // Cancel the background hold so this recovery round owns the connection
  cur.recovering = true
  cur.abort?.abort()
  cur.abort = null
  const startedAt = Date.now()
  try {
    const res = await ilinkGetUpdates(fetcher, token, cur.buf, RECOVER_TIMEOUT_MS)
    if (res.nextBuf && res.nextBuf !== cur.buf) {
      cur.buf = res.nextBuf
      saveCursor(token, res.nextBuf)
    }
    markOk()
    return true
  } catch (e) {
    // A timeout/abort means the server kept the poll open — that IS the
    // prepared state, so the retry is worth spending.
    const held = Date.now() - startedAt >= RECOVER_TIMEOUT_MS - 1_000
    if (held || isIlinkAbortError(e)) {
      markOk()
      return true
    }
    return false
  } finally {
    cur.recovering = false
    // The original runLoop (if any) observes recovering=false and resumes;
    // never spawn a second loop here or two long-polls would race the token.
  }
}

/** AbortError / TimeoutError from AbortSignal.timeout or an explicit abort */
function isIlinkAbortError(e: unknown): boolean {
  if (e == null || typeof e !== 'object') return false
  const name = (e as { name?: unknown }).name
  return name === 'AbortError' || name === 'TimeoutError'
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
    // Stamp the dispatch time: an idle poll is answered by the server holding
    // it open, so "in flight past the settle window" is the strongest
    // available evidence that the platform is prepared for sendmessage.
    s.pollStartedAt = Date.now()
    const startedAt = s.pollStartedAt
    try {
      const res = await ilinkGetUpdates(fetcher, s.token, s.buf, LOOP_TIMEOUT_MS, abort.signal)
      if (!s.running || state !== s) return
      s.pollStartedAt = 0
      if (res.nextBuf && res.nextBuf !== s.buf) {
        s.buf = res.nextBuf
        saveCursor(s.token, res.nextBuf)
      }
      markOk()
    } catch (e) {
      if (!s.running || state !== s) return
      s.pollStartedAt = 0
      // Recover aborted this round on purpose — loop back and wait
      if (s.recovering) continue
      // A poll our own timeout ended is a healthy idle round (the server held
      // it open and simply had nothing to deliver), so it counts as a
      // successful keep-alive and the next round re-arms immediately.
      // Backing off here would let the session cool down between alerts.
      if (Date.now() - startedAt >= LOOP_TIMEOUT_MS - 1_000) {
        markOk()
        continue
      }
      // Transient network / platform blip: rest briefly then poll again.
      // Auth failures also land here; the send path surfaces them.
      await new Promise((r) => setTimeout(r, LOOP_ERROR_BACKOFF_MS))
    }
  }
}
