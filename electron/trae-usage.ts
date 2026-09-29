import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createDecipheriv, createHash } from 'node:crypto'

/**
 * Trae CN (Trae SOLO CN / Trae CN IDE) subscription usage probe, mirroring the
 * codex/claude/gemini/grok contract: read the LOCAL login state, query the
 * official endpoint, return usage numbers only — the JWT never crosses the IPC
 * boundary and is never logged.
 *
 * Local sessions of Trae CN live in a SQLCipher 4 encrypted store whose key
 * only exists in the running IDE's process memory; per-turn token counters
 * (`chat_turn.context.token_usage`) are read from it by
 * electron/trae-local-usage.ts and merged into the local agent scan. This
 * module covers the other machine-readable surface: the account's credits
 * summary,
 * `POST https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage`, which the IDE
 * itself calls on startup (verified against 2026-09 builds).
 *
 * Authentication: the login state sits in
 * `<appData>/User/globalStorage/storage.json` under `iCubeAuthInfo://icube.cloudide`
 * as a base64 "tc" blob: `[6B header][32B random][AES-128-CBC ciphertext]`,
 * where the key is SHA-512(SHA-512(random) + SALT_A⊕SALT_B) — salts are
 * hardcoded in Trae CN's frontend JS (public reverse engineering, see the
 * ZedeX/trae-local-api CRACK_TUTORIAL). Decrypted payload:
 * `{token, refreshToken, expiredAt, userId, account}`. The token lives ~14
 * days; the IDE refreshes it on every launch, so an expired token simply maps
 * to the honest "reopen Trae" state — this module never attempts a refresh
 * (the refresh call needs an ECDSA device proof outside our scope).
 *
 * The international build (`TRAE SOLO` / `Trae`) stores the same key as
 * plaintext JSON and is served by tokscale's `trae sync`; it is deliberately
 * not probed here to avoid a second account surface with different endpoints.
 */

export interface TraeUsageOutcome {
  available: boolean
  body?: string
  reason?: string
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

const USAGE_URL = 'https://api.trae.cn/trae/api/v2/pay/ide_user_ent_usage'
const PROBE_TIMEOUT_MS = 10_000
const APP_ID = '6eefa01c-1036-4c7e-9ca5-d891f63bfcd8'

/** Candidate app-data dirs, newest layout first */
const APP_DIRS = ['TRAE SOLO CN', 'Trae CN'] as const

// Salt pairs from Trae CN's frontend JS: "tc"-AES uses A⊕B, AES_PRIVATE C⊕D.
const SALT_A = Uint8Array.from([
  82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155,
  47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76,
  149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37,
])
const SALT_B = Uint8Array.from([
  31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181,
  74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235,
  187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125,
])
const SALT_C = Uint8Array.from([
  191, 192, 216, 250, 122, 246, 220, 97, 31, 254, 98, 27, 8, 72, 71, 176, 135, 99, 96, 18, 127,
  101, 203, 104, 211, 102, 191, 125, 37, 72, 150, 156, 51, 229, 121, 35, 17, 153, 141, 177, 110,
  131, 150, 128, 172, 255, 254, 6, 18, 140, 55, 62, 236, 249, 135, 64, 135, 12, 117, 4, 89, 149, 168, 209,
])
const SALT_D = Uint8Array.from([
  246, 204, 26, 232, 232, 70, 129, 109, 223, 146, 169, 242, 23, 241, 105, 145, 50, 196, 165, 42,
  254, 120, 3, 54, 244, 207, 209, 85, 53, 6, 138, 106, 175, 148, 31, 204, 186, 186, 165, 182, 87,
  142, 49, 10, 39, 110, 26, 154, 86, 56, 173, 125, 18, 64, 198, 225, 99, 99, 83, 82, 191, 134, 76, 170,
])

function xorSalts(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i]
  return out
}

interface TraeAuth {
  token: string
  userId: string
  expiredAt: string | null
}

/**
 * Decrypt one "tc" storage value. Returns null for anything the shim does not
 * recognize (plaintext values, foreign headers, torn data) — never throws, so
 * an unreadable blob degrades to the honest unavailable state.
 */
function decryptTcValue(value: unknown): TraeAuth | null {
  if (typeof value !== 'string' || value === '') return null
  // International builds keep the same key as plaintext JSON — probe callers
  // treat that layout as out of scope, but tolerate it defensively.
  if (value.trimStart().startsWith('{')) {
    try {
      const plain = JSON.parse(value) as { token?: unknown; userId?: unknown; expiredAt?: unknown }
      return typeof plain.token === 'string' && plain.token !== ''
        ? {
            token: plain.token,
            userId: typeof plain.userId === 'string' ? plain.userId : '',
            expiredAt: typeof plain.expiredAt === 'string' ? plain.expiredAt : null,
          }
        : null
    } catch {
      return null
    }
  }
  try {
    const buf = Buffer.from(value, 'base64')
    if (buf.length < 38 + 64 + 2) return null
    const header = buf.subarray(0, 6)
    const isAes = header[0] === 0x74 && header[1] === 0x63 && header[2] === 5 && header[3] === 0x10
    const isPrivate = header[0] === 18 && header[1] === 57 && header[2] === 32 && header[3] === 32
    if (!isAes && !isPrivate) return null
    const salt = xorSalts(isPrivate ? SALT_C : SALT_A, isPrivate ? SALT_D : SALT_B)
    const hashOfRandom = createHash('sha512').update(buf.subarray(6, 38)).digest()
    const finalHash = createHash('sha512').update(Buffer.concat([hashOfRandom, salt])).digest()
    const decipher = createDecipheriv('aes-128-cbc', finalHash.subarray(0, 16), finalHash.subarray(16, 32))
    const plain = Buffer.concat([decipher.update(buf.subarray(38)), decipher.final()])
    // [64B SHA-512 of the body][body JSON] — the checksum doubles as a decrypt
    // sanity check before anything is parsed.
    const stored = plain.subarray(0, 64)
    const body = plain.subarray(64)
    if (!stored.equals(createHash('sha512').update(body).digest())) return null
    const parsed = JSON.parse(body.toString('utf8')) as {
      token?: unknown
      userId?: unknown
      expiredAt?: unknown
    }
    if (typeof parsed.token !== 'string' || parsed.token === '') return null
    return {
      token: parsed.token,
      userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      expiredAt: typeof parsed.expiredAt === 'string' ? parsed.expiredAt : null,
    }
  } catch {
    return null
  }
}

/** First app-data dir (of the candidates) that exists, via its storage file */
async function findStorageFile(appData: string): Promise<string | null> {
  for (const dir of APP_DIRS) {
    const file = join(appData, dir, 'User', 'globalStorage', 'storage.json')
    try {
      const raw = await readFile(file, 'utf8')
      if (raw) return file
    } catch {
      // try the next layout
    }
  }
  return null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * Probe Trae CN credits usage. The normalized body carries only numbers and
 * display labels: `{percent, consumed, total, resetsAt, plan, packs[]}`.
 */
export async function fetchTraeUsage(fetchImpl: FetchImpl, homeDir: string): Promise<TraeUsageOutcome> {
  try {
    const appData = process.env.APPDATA?.trim() || join(homeDir, 'AppData', 'Roaming')
    const storageFile = await findStorageFile(appData)
    if (!storageFile) return { available: false, reason: 'no-auth-file' }
    const storage = JSON.parse(await readFile(storageFile, 'utf8')) as Record<string, unknown>
    const auth = decryptTcValue(storage['iCubeAuthInfo://icube.cloudide'])
    if (!auth) return { available: false, reason: 'no-auth-token' }
    if (auth.expiredAt && Date.parse(auth.expiredAt) <= Date.now()) {
      return { available: false, reason: 'token-expired' }
    }

    // The machineid file rides next to the storage dir; the endpoint does not
    // validate it, so a missing file simply omits the header.
    const machineIdFile = join(storageFile, '..', '..', '..', 'machineid')
    let machineId: string | null = null
    try {
      machineId = (await readFile(machineIdFile, 'utf8')).trim() || null
    } catch {
      // header stays optional
    }

    const headers: Record<string, string> = {
      Authorization: `Cloud-IDE-JWT ${auth.token}`,
      'X-Cloudide-Token': auth.token,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-app-id': APP_ID,
      'x-device-type': 'windows',
    }
    if (auth.userId) headers['x-uid'] = auth.userId
    if (machineId) headers['x-machine-id'] = machineId

    const res = await fetchImpl(USAGE_URL, {
      method: 'POST',
      headers,
      body: '{}',
      redirect: 'error',
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    })
    if (res.status === 401 || res.status === 403) return { available: false, reason: `http-${res.status}` }
    if (!res.ok) return { available: false, reason: `http-${res.status}` }

    const json = (await res.json()) as {
      usage_summary?: { consumed_amount?: unknown; total_amount?: unknown; consumption_ratio?: unknown }
      user_entitlement_pack_list?: Array<{
        display_desc?: unknown
        expire_time?: unknown
        status?: unknown
        is_hide?: unknown
        entitlement_base_info?: {
          quota?: { credits_limit?: unknown }
        }
      }>
      is_credits_billing?: unknown
    }
    const summary = json.usage_summary ?? {}
    const consumed = num(summary.consumed_amount)
    const total = num(summary.total_amount)
    if (consumed == null || total == null || total <= 0) {
      return { available: false, reason: 'malformed-body' }
    }
    const ratio = num(summary.consumption_ratio)
    const percent = ratio != null ? ratio * 100 : (consumed / total) * 100

    const packs: Array<{ name: string; credits: number | null; resetsAt: number | null }> = []
    for (const pack of json.user_entitlement_pack_list ?? []) {
      if (pack.status !== 1 || pack.is_hide === true) continue
      const name = typeof pack.display_desc === 'string' ? pack.display_desc : ''
      if (!name) continue
      const expireSec = num(pack.expire_time)
      packs.push({
        name,
        credits: num(pack.entitlement_base_info?.quota?.credits_limit),
        resetsAt: expireSec != null ? expireSec * 1000 : null,
      })
    }
    // Reset anchor: the earliest expiring active pack (the next period rollover)
    const resetsAt = packs
      .map((p) => p.resetsAt)
      .filter((v): v is number => v != null && v > Date.now())
      .sort((a, b) => a - b)[0] ?? null

    const body = JSON.stringify({
      percent: Math.min(100, Math.max(0, percent)),
      consumed,
      total,
      unit: 'credits',
      resetsAt,
      plan: json.is_credits_billing === true ? 'Trae CN' : null,
      packs,
    })
    return { available: true, body }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}
