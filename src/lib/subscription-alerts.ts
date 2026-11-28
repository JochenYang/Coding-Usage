import type { Dict } from '../i18n/types'
import type { UsageMetric } from '../types'
import type { AlertSource } from './alerts'
import { SUBSCRIPTION_CARDS } from './subscription-cards'
import { codexWindowLabel, summarizeCodexQuota } from './codex-quota'
import { summarizeClaudeQuota } from './claude-quota'
import { summarizeGeminiQuota } from './gemini-quota'
import { summarizeGrokQuota } from './grok-quota'
import { summarizeTraeQuota } from './trae-quota'
import { KIMI_WINDOW_LABELS, summarizeKimiQuota } from './kimi-quota'
import {
  ANTIGRAVITY_FLAVOURS,
  ANTIGRAVITY_GROUP_LABELS,
  ANTIGRAVITY_WINDOW_LABELS,
  summarizeAntigravityQuota,
} from './antigravity-quota'
import { summarizeCursorQuota, summarizeCopilotQuota } from './local-plan-quota'
import { summarizeSessionQuota } from './session-quota'
import { summarizeAmpQuota, AMP_METER_LABELS } from './amp-quota'
import { summarizeFactoryQuota, FACTORY_WINDOW_LABELS } from './factory-quota'
import { summarizeDevinQuota, DEVIN_WINDOW_LABELS } from './devin-quota'
import { summarizeOpendesignQuota, opendesignWindowLabel } from './opendesign-quota'

/**
 * Subscription quota windows as alert input.
 *
 * The official subscription cards (Claude, Codex, Gemini, …) sit outside the
 * provider pipeline: every card probes on its own and the only shared record
 * is the main process's last-known-good snapshot (`quotaSnapshot()`). This
 * module turns that snapshot into the metrics `deriveAlerts` reads, so the
 * island, the alerts center and the webhook push see a subscription window
 * the same way they see an account's plan window.
 *
 * Each card's own summarizer parses its body — the alert never re-decodes a
 * vendor payload, so a parser fix lands in both places. The snapshot only
 * ever holds successful probes (quota-store never writes a failure), which
 * means an unavailable login keeps its last good reading until it ages out
 * below; `resetsAt` guards the rest: a window whose reset point has passed
 * is stale by construction and raises nothing.
 */

/** One `quotaSnapshot()` entry: when it was fetched and what the probe returned */
export interface QuotaSnapshotEntryLike {
  at: number
  result: { available: boolean; body?: string; reason?: string }
}

export type QuotaSnapshotLike = Record<string, QuotaSnapshotEntryLike>

/**
 * A snapshot older than this is not a reading. The cards re-probe only while
 * the plans page is open, so a user who stays elsewhere leaves the snapshot
 * standing; a day-old percentage would announce a window that has since
 * rolled over several times. The per-window `resetsAt` check in the engine
 * covers the short windows; this bounds the weekly and monthly ones.
 */
export const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60_000

/** The three Antigravity cards share one allowance, so they raise one alert */
const ANTIGRAVITY_AGENT_NAME = 'Antigravity'
const ANTIGRAVITY_KEYS = Object.values(ANTIGRAVITY_FLAVOURS).map((f) => f.key)

/** The probe outcome shape every summarizer below accepts */
interface OutcomeLike {
  available: boolean
  body?: string
  reason?: string
}

type Normalizer = (outcome: OutcomeLike, t: Dict) => UsageMetric[]

function percentMetric(id: string, label: string, percent: number, resetsAt: number | null): UsageMetric {
  return { id, label, kind: 'percent', percent, ...(resetsAt != null ? { resetsAt } : {}) }
}

/**
 * Windows whose id doubles as the i18n key under `t.windows` (the local-plan
 * cards). That table also holds two formatter functions, hence the two-step
 * cast; every window id indexes a string member.
 */
function fromLocalPlan(
  vm: { available: boolean; windows: { id: string; percent: number; resetsAt: number | null }[] },
  t: Dict,
): UsageMetric[] {
  if (!vm.available) return []
  const labels = t.windows as unknown as Record<string, string>
  return vm.windows.map((w) => percentMetric(w.id, labels[w.id] ?? w.id, w.percent, w.resetsAt))
}

const NORMALIZERS: Record<string, Normalizer> = {
  codex: (raw, t) => {
    const vm = summarizeCodexQuota(raw)
    if (!vm.available) return []
    const out: UsageMetric[] = []
    if (vm.primary) out.push(percentMetric('primary', codexWindowLabel(vm.primary.windowSeconds, t), vm.primary.percent, vm.primary.resetsAt))
    if (vm.secondary) out.push(percentMetric('secondary', codexWindowLabel(vm.secondary.windowSeconds, t), vm.secondary.percent, vm.secondary.resetsAt))
    return out
  },
  claude: (raw, t) => {
    const vm = summarizeClaudeQuota(raw)
    if (!vm.available) return []
    const windows = vm.windows.map((w) => percentMetric(w.id, t.manage.claudeWindows[w.id], w.percent, w.resetsAt))
    // Model-scoped allowances carry a server label and no id; the label is
    // the only stable identity they have.
    const scoped = vm.scoped.map((w) => percentMetric(`scoped-${w.label}`, w.label, w.percent, w.resetsAt))
    return [...windows, ...scoped]
  },
  gemini: (raw, t) => {
    const vm = summarizeGeminiQuota(raw)
    if (!vm.available) return []
    return vm.groups.map((g) => percentMetric(g.id, t.manage.geminiGroups[g.id], g.percent, g.resetsAt))
  },
  grok: (raw, t) => {
    const vm = summarizeGrokQuota(raw)
    if (!vm.available) return []
    return [percentMetric('billing', t.manage.grokBilling, vm.percent, vm.resetsAt)]
  },
  trae: (raw, t) => {
    const vm = summarizeTraeQuota(raw)
    if (!vm.available) return []
    // Packs expire on their own schedule; the period window is what "quota"
    // means for alerts.
    return [percentMetric('period', t.manage.traeBilling, vm.percent, vm.resetsAt)]
  },
  'trae-intl': (raw, t) => {
    const vm = summarizeTraeQuota(raw)
    if (!vm.available) return []
    return [percentMetric('period', t.manage.traeBilling, vm.percent, vm.resetsAt)]
  },
  kimi: (raw, t) => {
    const vm = summarizeKimiQuota(raw)
    if (!vm.available) return []
    return vm.windows.map((w) => percentMetric(w.id, KIMI_WINDOW_LABELS[w.id](t), w.percent, w.resetsAt))
  },
  cursor: (raw, t) => fromLocalPlan(summarizeCursorQuota(raw), t),
  copilot: (raw, t) => fromLocalPlan(summarizeCopilotQuota(raw), t),
  cline: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  jetbrains: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  windsurf: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  kiro: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  kilo: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  alibaba: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  qwen: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  alitoken: (raw, t) => fromLocalPlan(summarizeSessionQuota(raw), t),
  factory: (raw, t) => {
    const vm = summarizeFactoryQuota(raw)
    if (!vm.available) return []
    return vm.windows.map((w) => percentMetric(w.id, FACTORY_WINDOW_LABELS[w.id](t), w.percent, w.resetsAt))
  },
  devin: (raw, t) => {
    const vm = summarizeDevinQuota(raw)
    if (!vm.available) return []
    return vm.windows.map((w) => percentMetric(w.id, DEVIN_WINDOW_LABELS[w.id](t), w.percent, w.resetsAt))
  },
  amp: (raw, t) => {
    const vm = summarizeAmpQuota(raw)
    if (!vm.available) return []
    return vm.meters.map((w) => percentMetric(w.id, AMP_METER_LABELS[w.id](t), w.percent, w.resetsAt))
  },
  opendesign: (raw, t) => {
    const vm = summarizeOpendesignQuota(raw)
    if (!vm.available) return []
    return vm.windows.map((w) => percentMetric(w.id, opendesignWindowLabel(w.id, t), w.percent, w.resetsAt))
  },
}

/** Card brand name as the alerts show it; the registry name is not translated */
function agentName(key: string): string {
  return SUBSCRIPTION_CARDS.find((card) => card.key === key)?.name ?? key
}

/**
 * The Antigravity allowance is one pool seen through three clients, so the
 * three snapshot slots hold the same windows. One source is raised from the
 * freshest available slot among the ENABLED cards — a disabled card must not
 * speak (its slot may even be another account: the IDE keeps its own login).
 */
function antigravitySource(
  snapshot: QuotaSnapshotLike,
  enabled: ReadonlySet<string>,
  t: Dict,
  now: number,
): AlertSource | null {
  let newest: QuotaSnapshotEntryLike | null = null
  for (const key of ANTIGRAVITY_KEYS) {
    if (!enabled.has(key)) continue
    const entry = snapshot[key]
    if (!entry?.result.available || now - entry.at > SNAPSHOT_MAX_AGE_MS) continue
    if (!newest || entry.at > newest.at) newest = entry
  }
  if (!newest) return null
  const vm = summarizeAntigravityQuota(newest.result)
  if (!vm.available) return null
  const metrics: UsageMetric[] = []
  for (const group of vm.groups) {
    for (const bucket of group.buckets) {
      const label = `${ANTIGRAVITY_GROUP_LABELS[group.id](t)} · ${ANTIGRAVITY_WINDOW_LABELS[bucket.window](t)}`
      // The service reports what is LEFT; the engine and every other card
      // speak in used percentages.
      metrics.push(percentMetric(`${group.id}.${bucket.id}`, label, 100 - bucket.remainingPct, bucket.resetsAt))
    }
  }
  return { key: 'antigravity', agentName: ANTIGRAVITY_AGENT_NAME, metrics }
}

/**
 * Alert sources for every enabled subscription card with a fresh reading.
 * `enabled` is the user's card list: a disabled card must not keep raising
 * alerts from a snapshot it left behind. `now` is passed in so the age check
 * is testable and consistent with the derive round.
 */
export function subscriptionAlertSources(
  snapshot: QuotaSnapshotLike,
  enabled: ReadonlySet<string>,
  t: Dict,
  now: number,
): AlertSource[] {
  const sources: AlertSource[] = []
  let antigravityHandled = false
  for (const key of Object.keys(snapshot)) {
    if (!enabled.has(key)) continue
    const entry = snapshot[key]
    if (!entry?.result.available || now - entry.at > SNAPSHOT_MAX_AGE_MS) continue
    if (ANTIGRAVITY_KEYS.includes(key)) {
      if (!antigravityHandled) {
        const source = antigravitySource(snapshot, enabled, t, now)
        if (source) sources.push(source)
        antigravityHandled = true
      }
      continue
    }
    const normalize = NORMALIZERS[key]
    // A card without a normalizer (qoder reports no reset time) is skipped
    // rather than half-wired: it could raise "usage high" but never say when
    // the window recovers, which is the half that matters.
    if (!normalize) continue
    const metrics = normalize(entry.result, t)
    if (metrics.length === 0) continue
    sources.push({ key, agentName: agentName(key), metrics })
  }
  return sources
}
