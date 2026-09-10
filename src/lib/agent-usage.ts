/**
 * Local AI coding-agent usage scanner.
 *
 * The heavy lifting (reading per-agent session logs) is done by the tokscale
 * CLI binary, spawned inside the Electron main process via the `tokscale:scan`
 * IPC channel. One `tokscale graph` invocation returns per-day contributions;
 * this module validates the JSON and aggregates them into today / month /
 * all-time totals, per-agent rows (plus an "other" row for unclassified
 * entries such as tokscale's synthetic rows), model/provider detail and the
 * daily series that powers the trend chart.
 *
 * Privacy: everything stays local. Only aggregated numbers cross this module —
 * never prompts, responses, or any message content.
 */
import { displayProviderName } from './provider-labels'

/**
 * Local agent clients tracked through the tokscale scan. Ids must be valid
 * `tokscale graph --client` values; keep electron/main.ts TOKSCALE_CLIENTS in
 * sync (the same list is passed to the CLI). Order = display order.
 */
export const AGENT_CLIENTS = [
  'codex',
  'claude',
  'kimi',
  'opencode',
  'gemini',
  'cursor',
  'copilot',
  'qwen',
  'trae',
  'workbuddy',
  'cline',
  'roocode',
  'kilocode',
  'goose',
  'zed',
  'kiro',
  'augment',
  'droid',
  'amp',
  'grok',
  'dsh',
  'zcode',
  'micode',
] as const
export type AgentClientId = (typeof AGENT_CLIENTS)[number]

export interface AgentPeriodVM {
  /** input + output + cacheRead + cacheWrite (tokens, matching tokscale's totals) */
  tokens: number
  /** input-only tokens (cache excluded) */
  input: number
  output: number
  cacheRead: number
  costUsd: number
  messages: number
}

export interface AgentClientVM {
  client: AgentClientId
  /** True when any period has data for this client */
  exists: boolean
  today: AgentPeriodVM
  month: AgentPeriodVM
  allTime: AgentPeriodVM
}

/** tokens/cost for one model or provider label (analysis views) */
export interface CostSliceVM {
  label: string
  tokens: number
  input: number
  output: number
  cacheRead: number
  costUsd: number
  /** True when at least one contributing entry was priced from the model catalog */
  priced: boolean
}

export interface AgentUsageVM {
  clients: AgentClientVM[]
  /** Unclassified contributions (missing/synthetic client ids) — keeps the
   *  per-agent rows summing to the real totals */
  other: { today: AgentPeriodVM; month: AgentPeriodVM; all: AgentPeriodVM } | null
  todayTotal: AgentPeriodVM
  monthTotal: AgentPeriodVM
  allTimeTotal: AgentPeriodVM
  todayByModel: CostSliceVM[]
  monthCostByProvider: CostSliceVM[]
  monthCostByModel: CostSliceVM[]
  /** per-day total tokens (oldest first) — powers the trend chart */
  dailySeries: { day?: string; label: string; value: number; input: number; output: number; cacheRead: number; cacheWrite: number; models?: DayModelSlice[] }[]
  /** Client ids whose scan failed in the degraded per-client fallback; null when clean */
  skippedClients: string[] | null
  /** Per-client failure reason keyed by client id (mirrors skippedClients); absent on old payloads */
  skippedDetails?: Record<string, string>
  scannedAt: number | null
  error: string | null
  loading?: boolean
}

function zero(): AgentPeriodVM {
  return { tokens: 0, input: 0, output: 0, cacheRead: 0, costUsd: 0, messages: 0 }
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Per-day contribution entry from `tokscale graph` */
interface GraphContribution {
  date: string
  totals: { tokens?: number; cost?: number; messages?: number }
  tokenBreakdown?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  clients?: {
    client?: string
    modelId?: string
    providerId?: string
    tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; reasoning?: number }
    cost?: number
    messages?: number
    /** Set by the main process when repriced from the OpenRouter catalog */
    priced?: boolean
  }[]
}

interface SliceAgg extends AgentPeriodVM {}

function addSlice(map: Map<string, SliceAgg>, key: string, p: AgentPeriodVM): void {
  const hit = map.get(key) ?? zero()
  map.set(key, {
    tokens: hit.tokens + p.tokens,
    input: hit.input + p.input,
    output: hit.output + p.output,
    cacheRead: hit.cacheRead + p.cacheRead,
    costUsd: hit.costUsd + p.costUsd,
    messages: hit.messages + p.messages,
  })
}

function makePeriod(parts: {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  cost: number
  messages: number
}): AgentPeriodVM {
  return {
    tokens: parts.input + parts.output + parts.cacheRead + parts.cacheWrite,
    input: parts.input,
    output: parts.output,
    cacheRead: parts.cacheRead,
    costUsd: parts.cost,
    messages: parts.messages,
  }
}

/** Day-level totals carry no breakdown inside `totals` — use tokenBreakdown */
function dayPeriod(
  totals: { tokens?: number; cost?: number; messages?: number },
  breakdown?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
): AgentPeriodVM {
  return makePeriod({
    input: numberOr(breakdown?.input),
    output: numberOr(breakdown?.output),
    cacheRead: numberOr(breakdown?.cacheRead),
    cacheWrite: numberOr(breakdown?.cacheWrite),
    cost: numberOr(totals.cost),
    messages: numberOr(totals.messages),
  })
}

/** Per-client-entry period from its tokens object */
function entryPeriod(e: {
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  cost?: number
  messages?: number
}): AgentPeriodVM {
  return makePeriod({
    input: numberOr(e.tokens?.input),
    output: numberOr(e.tokens?.output),
    cacheRead: numberOr(e.tokens?.cacheRead),
    cacheWrite: numberOr(e.tokens?.cacheWrite),
    cost: numberOr(e.cost),
    messages: numberOr(e.messages),
  })
}

function toSlice(list: [string, SliceAgg][], priced?: Map<string, boolean>): CostSliceVM[] {
  return list.map(([label, v]) => ({
    label,
    tokens: v.tokens,
    input: v.input,
    output: v.output,
    cacheRead: v.cacheRead,
    costUsd: v.costUsd,
    priced: priced?.get(label) ?? false,
  }))
}

/** Provider slices render the friendly router name (raw id when unmapped) */
function toProviderSlice(list: [string, SliceAgg][]): CostSliceVM[] {
  // Provider aggregates mix catalog-priced and tokscale-native costs, so the
  // unpriced label does not apply here — a zero simply renders as "—".
  return list.map(([id, v]) => ({
    label: displayProviderName(id),
    tokens: v.tokens,
    input: v.input,
    output: v.output,
    cacheRead: v.cacheRead,
    costUsd: v.costUsd,
    priced: true,
  }))
}

function sortedByTokens(list: [string, SliceAgg][], priced?: Map<string, boolean>): CostSliceVM[] {
  return toSlice(list, priced).sort((a, b) => b.tokens - a.tokens)
}

function sortedByCost(list: [string, SliceAgg][], priced?: Map<string, boolean>): CostSliceVM[] {
  return toSlice(list, priced).sort((a, b) => b.costUsd - a.costUsd)
}

function sortedByProviderCost(list: [string, SliceAgg][]): CostSliceVM[] {
  return toProviderSlice(list).sort((a, b) => b.costUsd - a.costUsd)
}

/** One model's token share within a single day (trend tooltip detail) */
export interface DayModelSlice {
  label: string
  tokens: number
}

/** Max model rows kept per day for the trend tooltip */
const DAY_MODELS_KEPT = 5

function emptyVM(
  error: string | null,
  skippedClients: string[] | null = null,
  skippedDetails?: Record<string, string>,
): AgentUsageVM {
  return {
    clients: AGENT_CLIENTS.map((c) => ({
      client: c,
      exists: false,
      today: zero(),
      month: zero(),
      allTime: zero(),
    })),
    other: null,
    todayTotal: zero(),
    monthTotal: zero(),
    allTimeTotal: zero(),
    todayByModel: [],
    monthCostByProvider: [],
    monthCostByModel: [],
    dailySeries: [],
    skippedClients,
    skippedDetails,
    scannedAt: null,
    error,
  }
}

function addPeriod(a: AgentPeriodVM, b: AgentPeriodVM): AgentPeriodVM {
  return {
    tokens: a.tokens + b.tokens,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    costUsd: a.costUsd + b.costUsd,
    messages: a.messages + b.messages,
  }
}

/**
 * Turn the raw `tokscale:scan` IPC payload (one `graph` data set with
 * `contributions[]`) into the view model. Never throws: malformed input falls
 * back to an empty-but-typed view so the UI can render honest empty/error
 * states instead of crashing.
 */
export function summarizeScan(raw: unknown): AgentUsageVM {
  if (!raw || typeof raw !== 'object') return emptyVM(null)
  const root = raw as { daily?: unknown; error?: string; skippedClients?: unknown; skippedDetails?: unknown }
  const skippedClients = Array.isArray(root.skippedClients)
    ? root.skippedClients.filter((c): c is string => typeof c === 'string')
    : null
  const skippedDetails =
    root.skippedDetails != null && typeof root.skippedDetails === 'object' && !Array.isArray(root.skippedDetails)
      ? Object.fromEntries(
          Object.entries(root.skippedDetails).filter(
            (e): e is [string, string] => typeof e[0] === 'string' && typeof e[1] === 'string',
          ),
        )
      : undefined
  if (typeof root.error === 'string' && root.error) return emptyVM(root.error, skippedClients, skippedDetails)

  const daily = (root.daily ?? {}) as { contributions?: unknown }
  const contribs: GraphContribution[] = (Array.isArray(daily.contributions) ? daily.contributions : [])
    .filter(
      (c): c is GraphContribution => !!c && typeof c === 'object' && typeof (c as GraphContribution).date === 'string',
    )
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))

  if (contribs.length === 0) return emptyVM('no data', skippedClients, skippedDetails)

  // Buckets anchor to the REAL local date, not "the last row": a dataset that
  // ends yesterday (no usage today yet) must show 0 for today, not relabel
  // yesterday as today — and must not write yesterday's numbers into today's
  // daily archive.
  const todayStr = todayKey()
  const monthPrefix = todayStr.slice(0, 7)

  let todayTotal = zero()
  let monthTotal = zero()
  let allTimeTotal = zero()
  let otherAll: AgentPeriodVM = zero()
  let otherMonth: AgentPeriodVM = zero()
  let otherToday: AgentPeriodVM = zero()

  const monthByClient = new Map<string, SliceAgg>()
  const allByClient = new Map<string, SliceAgg>()
  const todayByClient = new Map<string, SliceAgg>()
  const todayByModel = new Map<string, SliceAgg>()
  const monthByProvider = new Map<string, SliceAgg>()
  const monthByModel = new Map<string, SliceAgg>()
  // Catalog-priced flags per model label (an entry counts as priced when the
  // main process repriced it; tokscale-native costs stay unpriced)
  const todayModelPriced = new Map<string, boolean>()
  const monthModelPriced = new Map<string, boolean>()

  for (let i = 0; i < contribs.length; i++) {
    const c = contribs[i]
    const isToday = c.date === todayStr
    const isMonthDay = c.date.startsWith(monthPrefix)
    const p = dayPeriod(c.totals, c.tokenBreakdown)
    allTimeTotal = addPeriod(allTimeTotal, p)
    if (isMonthDay) monthTotal = addPeriod(monthTotal, p)
    if (isToday) todayTotal = addPeriod(todayTotal, p)
    // After the loop the `p` for today is recomputed from clients below —
    // day totals equal the sum of its client rows, except unclassified rows
    // (synthetic) which are captured in `other`.
    if (isToday) {
      let dayFromClients = zero()
      for (const e of c.clients ?? []) {
        const period = entryPeriod(e)
        dayFromClients = addPeriod(dayFromClients, period)
        const owner = typeof e.client === 'string' && e.client ? e.client : '__other__'
        // Unclassified entries take the same route as the historical branch:
        // straight into the "other" buckets. They stay out of dayFromClients
        // so the diff below only captures the synthetic totals-vs-clients gap.
        if (owner === '__other__') {
          otherToday = addPeriod(otherToday, period)
          otherAll = addPeriod(otherAll, period)
          if (isMonthDay) otherMonth = addPeriod(otherMonth, period)
          continue
        }
        addSlice(todayByClient, owner, period)
        // All-time buckets live here (not just in the non-today branch):
        // today is part of the cumulative totals too
        addSlice(allByClient, owner, period)
        const model = typeof e.modelId === 'string' && e.modelId ? e.modelId : undefined
        if (model) {
          addSlice(todayByModel, model, period)
          if (e.priced === true) todayModelPriced.set(model, true)
        }
        // Today always sits inside the current month: feed the month/provider
        // buckets too, otherwise every "本月" figure and the distribution
        // donut silently exclude today's spend until tomorrow.
        if (isMonthDay) {
          addSlice(monthByClient, owner, period)
          const provider = typeof e.providerId === 'string' && e.providerId ? e.providerId : undefined
          if (provider) addSlice(monthByProvider, provider, period)
          if (model) {
            addSlice(monthByModel, model, period)
            if (e.priced === true) monthModelPriced.set(model, true)
          }
        }
      }
      // Unclassified balance for today (synthetic rows are in totals.tokens
      // but not in any client entry)
      const dayOther = subtract(p, dayFromClients)
      otherToday = addPeriod(otherToday, dayOther)
      otherAll = addPeriod(otherAll, dayOther)
      otherMonth = addPeriod(otherMonth, dayOther)
    } else {
      for (const e of c.clients ?? []) {
        const period = entryPeriod(e)
        const owner = typeof e.client === 'string' && e.client ? e.client : '__other__'
        if (owner === '__other__') {
          otherAll = addPeriod(otherAll, period)
          if (isMonthDay) otherMonth = addPeriod(otherMonth, period)
          continue
        }
        addSlice(allByClient, owner, period)
        if (isMonthDay) addSlice(monthByClient, owner, period)
        const provider = typeof e.providerId === 'string' && e.providerId ? e.providerId : undefined
        const model = typeof e.modelId === 'string' && e.modelId ? e.modelId : undefined
        if (isMonthDay && provider) addSlice(monthByProvider, provider, period)
        if (isMonthDay && model) {
          addSlice(monthByModel, model, period)
          if (e.priced === true) monthModelPriced.set(model, true)
        }
      }
    }
  }

  const clients: AgentClientVM[] = AGENT_CLIENTS.map((c) => {
    const today = todayByClient.get(c) ?? zero()
    const month = monthByClient.get(c) ?? zero()
    const all = allByClient.get(c) ?? zero()
    return {
      client: c,
      exists: today.tokens > 0 || month.tokens > 0 || all.tokens > 0,
      today,
      month,
      allTime: all,
    }
  })

  const dailySeries = contribs.map((c) => {
    const byModel = new Map<string, number>()
    for (const e of c.clients ?? []) {
      const model = typeof e.modelId === 'string' && e.modelId ? e.modelId : null
      if (!model) continue
      const t =
        numberOr(e.tokens?.input) +
        numberOr(e.tokens?.output) +
        numberOr(e.tokens?.cacheRead) +
        numberOr(e.tokens?.cacheWrite)
      if (t > 0) byModel.set(model, (byModel.get(model) ?? 0) + t)
    }
    const models: DayModelSlice[] = [...byModel.entries()]
      .map(([label, tokens]) => ({ label, tokens }))
      .sort((a, b) => b.tokens - a.tokens)
      .slice(0, DAY_MODELS_KEPT)
    return {
      day: c.date,
      label: c.date.slice(5),
      value: numberOr(c.totals.tokens),
      input: numberOr(c.tokenBreakdown?.input),
      output: numberOr(c.tokenBreakdown?.output),
      cacheRead: numberOr(c.tokenBreakdown?.cacheRead),
      cacheWrite: numberOr(c.tokenBreakdown?.cacheWrite),
      models,
    }
  })

  return {
    clients,
    other:
      otherToday.tokens > 0 || otherMonth.tokens > 0 || otherAll.tokens > 0
        ? { today: otherToday, month: otherMonth, all: otherAll }
        : null,
    todayTotal,
    monthTotal,
    allTimeTotal,
    todayByModel: sortedByTokens([...todayByModel.entries()], todayModelPriced),
    monthCostByProvider: sortedByProviderCost([...monthByProvider.entries()]),
    // Models sort by cost so the ranking answers "where did the money go";
    // catalog-unpriced models (cost 0) sink to the bottom but stay listed in
    // full with the unpriced label instead of being cut off.
    monthCostByModel: sortedByCost([...monthByModel.entries()], monthModelPriced),
    dailySeries,
    skippedClients,
    skippedDetails,
    scannedAt: Date.now(),
    error: null,
  }
}

/** period p minus b, clamped at zero */
function subtract(a: AgentPeriodVM, b: AgentPeriodVM): AgentPeriodVM {
  return {
    tokens: Math.max(0, a.tokens - b.tokens),
    input: Math.max(0, a.input - b.input),
    output: Math.max(0, a.output - b.output),
    cacheRead: Math.max(0, a.cacheRead - b.cacheRead),
    costUsd: Math.max(0, a.costUsd - b.costUsd),
    messages: Math.max(0, a.messages - b.messages),
  }
}

/**
 * Apply the user's accounting mode to a period's headline token figure:
 * 'all' counts cache reads too, 'no-cache' counts input+output only.
 */
export function displayTokens(p: AgentPeriodVM, mode: 'all' | 'no-cache'): number {
  return mode === 'no-cache' ? p.input + p.output : p.tokens
}

/**
 * Mode-aware day total matching displayTokens semantics: the input+output
 * (+cache) breakdown sum, never the raw `totals.tokens` field, which can
 * drift from the breakdown (reasoning tokens etc.) and would make per-day
 * views disagree with the headline totals.
 */
export function displayDayTokens(
  p: { input: number; output: number; cacheRead?: number; cacheWrite?: number },
  mode: 'all' | 'no-cache',
): number {
  return mode === 'no-cache' ? p.input + p.output : p.input + p.output + (p.cacheRead ?? 0) + (p.cacheWrite ?? 0)
}

// ===== daily archive (fallback so history survives without graph) =====

const DAILY_KEY = 'coding-usage.agentUsage.daily'
const DAILY_RETENTION_DAYS = 90

function todayKey(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function loadDaily(): Record<string, number> {
  try {
    const raw = localStorage.getItem(DAILY_KEY)
    if (raw) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, number>
      }
    }
  } catch {
    // corrupted → start clean
  }
  return {}
}

/** Upsert today's total token consumption, pruning entries older than 90 days */
export function archiveDailyUsage(todayTokens: number): void {
  if (todayTokens <= 0) return
  const store = loadDaily()
  store[todayKey()] = todayTokens
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - DAILY_RETENTION_DAYS)
  const cutoffKey = `${cutoff.getFullYear()}-${`${cutoff.getMonth() + 1}`.padStart(2, '0')}-${`${cutoff.getDate()}`.padStart(2, '0')}`
  for (const key of Object.keys(store)) {
    if (key < cutoffKey) delete store[key]
  }
  try {
    localStorage.setItem(DAILY_KEY, JSON.stringify(store))
  } catch {
    // best-effort
  }
}

/** Daily total-token series from the local archive (oldest first) */
export function getDailyUsageSeries(days: number): { label: string; value: number }[] {
  const store = loadDaily()
  const out: { label: string; value: number }[] = []
  const now = new Date()
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
    const value = store[key]
    if (value != null && value > 0) {
      out.push({ label: `${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`, value })
    }
  }
  return out
}

/** Clear the daily archive (used by the settings page "clear snapshots" flow) */
export function clearDailyUsage(): void {
  try {
    localStorage.removeItem(DAILY_KEY)
  } catch {
    // ignore
  }
}
