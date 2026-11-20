import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { QuotaOutcome } from './subscription-quotas'

/**
 * JetBrains AI monthly credits from the IDE's own config.
 *
 * No network. The quota XML is written rarely; a newer `idea.log` record from
 * the same installation replaces it. A log from another IDE is never applied
 * to this installation's XML — the two may be different accounts. A malformed
 * latest log record is a miss, not a reason to reuse an older line or to show 0%.
 *
 * Windows config lives under `%APPDATA%\JetBrains` (Android Studio under
 * `%APPDATA%\Google`); the log is under `%LOCALAPPDATA%\<vendor>\<IDE>\log`.
 * macOS and Linux roots match the IDE's own layout.
 */

const QUOTA_FILE = 'AIAssistantQuotaManager2.xml'
const UNITS_PER_CREDIT = 100_000
const LOG_TAIL = 4 * 1024 * 1024
const QUOTA_MARKER = 'QuotaManager2Impl - New quota state is: '
const REFILL_MARKER = 'QuotaManager2Impl - New quota refill state is: '
const JUNIE_MARKER = 'AiaActivationTransmitter - Received message from junie: quota_update:'
const DISABLED_ASSISTANT = 'Error(exception=com.intellij.ml.llm.core.AIAssistantForbiddenException'

const IDE_PREFIXES: Array<[string, string]> = [
  ['IntelliJIdea', 'IntelliJ IDEA'],
  ['PyCharm', 'PyCharm'],
  ['WebStorm', 'WebStorm'],
  ['GoLand', 'GoLand'],
  ['CLion', 'CLion'],
  ['DataGrip', 'DataGrip'],
  ['RubyMine', 'RubyMine'],
  ['Rider', 'Rider'],
  ['PhpStorm', 'PhpStorm'],
  ['AppCode', 'AppCode'],
  ['Fleet', 'Fleet'],
  ['AndroidStudio', 'Android Studio'],
  ['RustRover', 'RustRover'],
  ['Aqua', 'Aqua'],
  ['DataSpell', 'DataSpell'],
]

interface QuotaNumbers {
  used: number
  maximum: number
  topUpCredits: number | null
  resetsAt: number | null
}

interface IdeHit {
  name: string
  quotaPath: string
  basePath: string
}

export function jetbrainsConfigRoots(home: string, env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = []
  if (env.APPDATA) {
    roots.push(join(env.APPDATA, 'JetBrains'), join(env.APPDATA, 'Google'))
  }
  roots.push(
    join(home, 'Library', 'Application Support', 'JetBrains'),
    join(home, 'Library', 'Application Support', 'Google'),
    join(home, '.config', 'JetBrains'),
    join(home, '.config', 'Google'),
    join(home, '.local', 'share', 'JetBrains'),
  )
  return roots
}

/** Log for this install only. A Windows config never reads a macOS or Linux log with the same folder name. */
export function jetbrainsLogPath(ideBase: string, home: string, env: NodeJS.ProcessEnv): string | null {
  const vendor = basename(dirname(ideBase))
  if (vendor !== 'JetBrains' && vendor !== 'Google') return null
  const configRoot = dirname(ideBase)
  const ide = basename(ideBase)
  if (env.APPDATA && configRoot === join(env.APPDATA, vendor)) {
    return env.LOCALAPPDATA ? join(env.LOCALAPPDATA, vendor, ide, 'log', 'idea.log') : null
  }
  if (configRoot === join(home, 'Library', 'Application Support', vendor)) {
    return join(home, 'Library', 'Logs', vendor, ide, 'idea.log')
  }
  if (configRoot === join(home, '.config', vendor) || configRoot === join(home, '.local', 'share', vendor)) {
    return join(home, '.cache', vendor, ide, 'log', 'idea.log')
  }
  return null
}

function decodeEntities(value: string): string {
  return value
    .replace(/&#(\d+);/g, (_, digits: string) => String.fromCodePoint(Number(digits)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function optionValue(component: string, name: string): string | null {
  const patterns = [
    new RegExp(`<option\\b[^>]*\\bname\\s*=\\s*["']${name}["'][^>]*\\bvalue\\s*=\\s*["']([^"']*)["']`, 'i'),
    new RegExp(`<option\\b[^>]*\\bvalue\\s*=\\s*["']([^"']*)["'][^>]*\\bname\\s*=\\s*["']${name}["']`, 'i'),
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(component)
    if (match?.[1]) return decodeEntities(match[1])
  }
  return null
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function pair(source: Record<string, unknown> | null, usedKey: string, maxKey: string): { used: number; maximum: number } | null {
  if (!source) return null
  const used = num(source[usedKey])
  const maximum = num(source[maxKey])
  if (used == null || maximum == null || maximum <= 0 || used < 0) return null
  return { used, maximum }
}

function topUpCredits(source: unknown): number | null {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return null
  const maximum = num((source as { maximum?: unknown }).maximum)
  const available = num((source as { available?: unknown }).available)
  if (maximum == null || available == null || maximum <= 0 || available < 0) return null
  return Math.min(available, maximum) / UNITS_PER_CREDIT
}

function isoMs(value: unknown): number | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/** Monthly used/maximum from the quotaInfo JSON. Tariff and total balances are never mixed. */
export function quotaFromInfo(json: unknown, refill: unknown): QuotaNumbers | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const body = json as Record<string, unknown>
  const tariff = body.tariffQuota
  const tariffObj = tariff && typeof tariff === 'object' && !Array.isArray(tariff) ? (tariff as Record<string, unknown>) : null
  const selected = pair(tariffObj, 'current', 'maximum') ?? pair(body, 'current', 'maximum')
  if (!selected) return null
  const refillObj = refill && typeof refill === 'object' && !Array.isArray(refill) ? (refill as Record<string, unknown>) : null
  const tariffRefill = refillObj?.tariff
  const nested = tariffRefill && typeof tariffRefill === 'object' ? (tariffRefill as { next?: unknown }).next : null
  return {
    used: selected.used,
    maximum: selected.maximum,
    topUpCredits: topUpCredits(body.topUpQuota),
    resetsAt: isoMs(refillObj?.next) ?? isoMs(nested),
  }
}

export function quotaFromXml(xml: string): QuotaNumbers | null {
  const component = /<component\b[^>]*\bname\s*=\s*["']AIAssistantQuotaManager2["'][^>]*>[\s\S]*?<\/component>/i.exec(xml)
  if (!component) return null
  const infoRaw = optionValue(component[0], 'quotaInfo')
  if (!infoRaw) return null
  let info: unknown
  let refill: unknown = null
  try {
    info = JSON.parse(infoRaw)
  } catch {
    return null
  }
  const refillRaw = optionValue(component[0], 'nextRefill')
  if (refillRaw) {
    try {
      refill = JSON.parse(refillRaw)
    } catch {
      refill = null
    }
  }
  return quotaFromInfo(info, refill)
}

function logTimestamp(line: string): number | null {
  const prefix = line.slice(0, 23)
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(prefix)
  if (!match) return null
  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  ).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function afterMarker(line: string, marker: string): string | null {
  const at = line.indexOf(marker)
  if (at < 0 || logTimestamp(line) == null) return null
  return line.slice(at + marker.length)
}

const LEGACY_QUOTA =
  /^Available\(current=([0-9.eE+-]+), maximum=([0-9.eE+-]+), until=([^,)\s]+), tariffQuota=QuotaDetails\(current=([0-9.eE+-]+), maximum=([0-9.eE+-]+), available=([0-9.eE+-]+)\)(?:, topUpQuota=QuotaDetails\(current=([0-9.eE+-]+), maximum=([0-9.eE+-]+), available=([0-9.eE+-]+)\))?\)$/

const JBAI_QUOTA =
  /^Available\(quota=JbaiQuota\(license=[^,()]*, current=([0-9.eE+-]+), maximum=([0-9.eE+-]+), quotaID=JbaiQuotaId\([^()]*\), until=([^,)\s]+), tariffQuota=Details\(current=([0-9.eE+-]+), maximum=([0-9.eE+-]+), available=([0-9.eE+-]+)\)(?:, topUpQuota=Details\(current=([0-9.eE+-]+), maximum=([0-9.eE+-]+), available=([0-9.eE+-]+)\))?\)\)$/

function numbersOf(groups: string[]): number[] | null {
  const values = groups.map(Number)
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return null
  return values
}

function quotaFromLegacy(state: string): QuotaNumbers | null {
  const match = LEGACY_QUOTA.exec(state) ?? JBAI_QUOTA.exec(state)
  if (!match) return null
  const tariffMax = Number(match[5])
  const used = Number(match[4])
  if (!Number.isFinite(tariffMax) || tariffMax <= 0 || !Number.isFinite(used) || used < 0) return null
  const topUp = match[8] != null && match[9] != null ? numbersOf([match[8], match[9]]) : null
  return {
    used,
    maximum: tariffMax,
    topUpCredits: topUp && topUp[0] > 0 ? Math.min(topUp[1], topUp[0]) / UNITS_PER_CREDIT : null,
    resetsAt: null,
  }
}

function quotaFromJunie(state: string): QuotaNumbers | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(state)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const tariff = (parsed as { tariffQuota?: unknown }).tariffQuota
  if (!tariff || typeof tariff !== 'object') return null
  const amount = (field: unknown): number | null => {
    if (!field || typeof field !== 'object') return null
    return num((field as { amount?: unknown }).amount)
  }
  const used = amount((tariff as { current?: unknown }).current)
  const maximum = amount((tariff as { maximum?: unknown }).maximum)
  if (used == null || maximum == null || maximum <= 0 || used < 0) return null
  const top = (parsed as { topUpQuota?: unknown }).topUpQuota
  const topAvailable = top && typeof top === 'object' ? amount((top as { available?: unknown }).available) : null
  const topMaximum = top && typeof top === 'object' ? amount((top as { maximum?: unknown }).maximum) : null
  return {
    used,
    maximum,
    topUpCredits:
      topAvailable != null && topMaximum != null && topMaximum > 0 && topAvailable >= 0
        ? Math.min(topAvailable, topMaximum) / UNITS_PER_CREDIT
        : null,
    resetsAt: null,
  }
}

const LEGACY_REFILL =
  /^Known\(next=([^,)\s]+), tariff=QuotaRefillInfoTariff\(amount=([0-9.eE+-]+), duration=([^,)\s]+)\)\)$/
const JBAI_REFILL =
  /^Known\(refill=JbaiQuotaRefill\(tariff=JbaiQuotaTariff\(amount=([0-9.eE+-]+), period=([^,)\s]+)\), next=([^,)\s]+), last=[^,)\s]+\)$/

function refillFromLine(line: string): number | null {
  const state = afterMarker(line, REFILL_MARKER)
  if (!state) return null
  const legacy = LEGACY_REFILL.exec(state)
  if (legacy) return isoMs(legacy[1])
  const jbai = JBAI_REFILL.exec(state)
  return jbai ? isoMs(jbai[3]) : null
}

export interface LogQuota {
  at: number
  quota: QuotaNumbers
}

/** Newest complete quota record in a log tail. An unrecognized latest record invalidates the tail. */
export function quotaFromLog(content: string): LogQuota | null {
  const lines = content.split(/\r?\n/).filter((line) => line.length > 0).reverse()
  let quota: LogQuota | null = null
  let resetsAt: number | null = null
  let sawRefill = false
  for (const line of lines) {
    if (line.includes(QUOTA_MARKER + DISABLED_ASSISTANT)) continue
    const legacy = afterMarker(line, QUOTA_MARKER)
    const junie = afterMarker(line, JUNIE_MARKER)
    if (legacy != null || junie != null) {
      const parsed = legacy != null ? quotaFromLegacy(legacy) : quotaFromJunie(junie ?? '')
      if (!parsed) {
        if (!quota) return null
        break
      }
      if (!quota) quota = { at: logTimestamp(line) ?? 0, quota: parsed }
    } else if (!sawRefill && line.includes(REFILL_MARKER)) {
      sawRefill = true
      resetsAt = refillFromLine(line)
    }
    if (quota && sawRefill) break
  }
  if (!quota) return null
  return { at: quota.at, quota: { ...quota.quota, resetsAt: resetsAt ?? quota.quota.resetsAt } }
}

async function readLogTail(path: string): Promise<string | null> {
  try {
    const info = await stat(path)
    const { open } = await import('node:fs/promises')
    const handle = await open(path, 'r')
    try {
      const count = Math.min(info.size, LOG_TAIL)
      const buf = Buffer.alloc(count)
      await handle.read(buf, 0, count, info.size - count)
      if (count === 0 || buf[count - 1] !== 0x0a) return null
      const start = info.size > LOG_TAIL ? buf.indexOf(0x0a) : -1
      const slice = start >= 0 ? buf.subarray(start + 1) : buf
      return slice.toString('utf8')
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function ideFromDir(name: string, root: string): IdeHit | null {
  const lower = name.toLowerCase()
  for (const [prefix, display] of IDE_PREFIXES) {
    if (!lower.startsWith(prefix.toLowerCase())) continue
    const version = name.slice(prefix.length) || 'Unknown'
    const basePath = join(root, name)
    return { name: `${display} ${version}`, quotaPath: join(basePath, 'options', QUOTA_FILE), basePath }
  }
  return null
}

async function detectIdes(home: string, env: NodeJS.ProcessEnv): Promise<IdeHit[]> {
  const found: IdeHit[] = []
  for (const root of jetbrainsConfigRoots(home, env)) {
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      continue
    }
    for (const name of names) {
      const ide = ideFromDir(name, root)
      if (ide) found.push(ide)
    }
  }
  return found
}

async function mtime(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs
  } catch {
    return null
  }
}

async function logQuota(ideBase: string, home: string, env: NodeJS.ProcessEnv): Promise<LogQuota | null> {
  const path = jetbrainsLogPath(ideBase, home, env)
  if (!path) return null
  const content = await readLogTail(path)
  return content ? quotaFromLog(content) : null
}

function bodyOf(plan: string | null, quota: QuotaNumbers): string {
  const percent = Math.max(0, Math.min(100, (quota.used / quota.maximum) * 100))
  return JSON.stringify({
    plan,
    windows: [{ id: 'jetbrainsMonthly', percent, resetsAt: quota.resetsAt }],
    topUpCredits: quota.topUpCredits,
    stale: false,
  })
}

export async function fetchJetBrainsQuota(home: string, env: NodeJS.ProcessEnv): Promise<QuotaOutcome> {
  const ides = await detectIdes(home, env)
  const evidence = await Promise.all(
    ides.map(async (ide) => {
      const xmlAt = await mtime(ide.quotaPath)
      const log = await logQuota(ide.basePath, home, env)
      const at = Math.max(xmlAt ?? 0, log?.at ?? 0)
      return { ide, xmlAt, log, at }
    }),
  )
  const selected = evidence.filter((item) => item.at > 0).sort((a, b) => b.at - a.at)[0]
  if (!selected) return { available: false, reason: 'no-auth' }
  // A newer log replaces a stale XML. An unreadable XML is not papered over with an older log.
  if (selected.log && selected.xmlAt != null && selected.log.at > selected.xmlAt) {
    return { available: true, body: bodyOf(selected.ide.name, selected.log.quota) }
  }
  if (selected.xmlAt != null) {
    const xml = quotaFromXml(await readFile(selected.ide.quotaPath, 'utf8').catch(() => ''))
    if (!xml) return { available: false, reason: 'parse-failed' }
    return { available: true, body: bodyOf(selected.ide.name, xml) }
  }
  if (selected.log) return { available: true, body: bodyOf(selected.ide.name, selected.log.quota) }
  return { available: false, reason: 'no-auth' }
}
