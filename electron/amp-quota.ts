import { spawn } from 'node:child_process'
import type { QuotaOutcome } from './subscription-quotas'

/**
 * Amp (ampcode.com) balance via the official CLI's own `amp usage` command.
 *
 * Amp has no fixed plan window to poll: the CLI prints a balance sheet — the
 * Amp Free daily meter, the subscription's other/orb pools with their renewal,
 * and the individual / workspace credit balances — that this probe reads the
 * same way tokscale reads its binaries. The CLI resolves its own login; the
 * probe sends nothing anywhere and reads no credential file itself.
 *
 * The output is human-readable text whose wording is not a published contract,
 * and builds have already wrapped the labels in Markdown bold once (CodexBar
 * issue #3171), so every meter is matched by its label after stripping ANSI
 * escapes and bold markers. A meter whose line cannot be parsed stays absent;
 * only a sheet with no meter at all fails the probe.
 */

export interface AmpUsageMeters {
  /** Subscription plan label from "Amp <plan> Subscription:", null when absent */
  plan: string | null
  /** Amp Free daily meter, as percent REMAINING (inverted to used later) */
  freeRemainingPercent: number | null
  /** Subscription "other usage" pool, percent remaining */
  subscriptionOtherRemainingPercent: number | null
  /** Subscription "orb usage" pool, percent remaining */
  subscriptionOrbRemainingPercent: number | null
  /** Subscription renewal, "resets upon renewal in N days" → epoch ms */
  subscriptionResetsAt: number | null
  /** Individual credits balance, USD */
  individualCreditsUsd: number | null
  /** Workspace credits balance, USD */
  workspaceCreditsUsd: number | null
}

export interface AmpCliResult {
  /** Exit code, null when the process never exited (spawn error / timeout) */
  code: number | null
  out: string
  err: string
  /** The binary could not be started at all (missing / cannot execute) */
  missing: boolean
  timedOut: boolean
}

export type AmpUsageRunner = () => Promise<AmpCliResult>

const CLI_TIMEOUT_MS = 10_000
const PLAN_MAX_LENGTH = 80

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value))
}

/** A remaining-percent figure, clamped into 0..100 before it is inverted */
function percentValue(value: string | undefined): number | null {
  if (value == null) return null
  const parsed = Number.parseFloat(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return Math.min(parsed, 100)
}

/** Money like "$3.23" / "$1,234.56"; thousands separators are display noise */
function moneyValue(value: string | undefined): number | null {
  if (value == null) return null
  const parsed = Number.parseFloat(value.replace(/,/g, ''))
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

/** Strip ANSI escapes and Markdown bold, then trim: both wrap the meter labels */
function normalizeLine(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\*\*/g, '').trim()
}

/**
 * One `amp usage` sheet, parsed by label. A line that drifts from the known
 * wording costs only its own meter; the plan label travels with the
 * subscription line, so a sheet without one reads as no plan.
 */
export function parseAmpUsageText(text: string, now: number = Date.now()): AmpUsageMeters | null {
  const meters: AmpUsageMeters = {
    plan: null,
    freeRemainingPercent: null,
    subscriptionOtherRemainingPercent: null,
    subscriptionOrbRemainingPercent: null,
    subscriptionResetsAt: null,
    individualCreditsUsd: null,
    workspaceCreditsUsd: null,
  }
  for (const rawLine of text.split('\n')) {
    const line = normalizeLine(rawLine)
    if (line === '') continue

    const free = /^Amp Free:\s*(\d+(?:\.\d+)?)\s*%\s*remaining/.exec(line)
    if (free) {
      meters.freeRemainingPercent = percentValue(free[1])
      continue
    }

    const subscription =
      /^Amp (.+?) Subscription:\s*(\d+(?:\.\d+)?)\s*%\s*other usage(?:\s+and\s+(\d+(?:\.\d+)?)\s*%\s*orb usage)?\s*remaining/.exec(
        line,
      )
    if (subscription) {
      const plan = subscription[1].trim().slice(0, PLAN_MAX_LENGTH)
      if (plan !== '') meters.plan = plan
      meters.subscriptionOtherRemainingPercent = percentValue(subscription[2])
      meters.subscriptionOrbRemainingPercent = percentValue(subscription[3])
      // The renewal is a relative offset ("resets upon renewal in 5 days");
      // an unparsable or absent note keeps the windows without a reset.
      const renewal = /resets upon renewal in (\d+)\s*days?/.exec(line)
      if (renewal) {
        const days = Number.parseInt(renewal[1], 10)
        if (Number.isFinite(days) && days >= 0) meters.subscriptionResetsAt = now + days * 86_400_000
      }
      continue
    }

    const individual = /^Individual credits:\s*\$([\d,]+(?:\.\d+)?)\s*remaining/.exec(line)
    if (individual) {
      meters.individualCreditsUsd = moneyValue(individual[1])
      continue
    }

    const workspace = /^Workspace credits:\s*\$([\d,]+(?:\.\d+)?)\s*remaining/.exec(line)
    if (workspace) {
      meters.workspaceCreditsUsd = moneyValue(workspace[1])
    }
  }

  const hasMeter =
    meters.freeRemainingPercent != null ||
    meters.subscriptionOtherRemainingPercent != null ||
    meters.subscriptionOrbRemainingPercent != null ||
    meters.individualCreditsUsd != null ||
    meters.workspaceCreditsUsd != null
  return hasMeter ? meters : null
}

/**
 * The normalized body the balance card reads: windows carry CONSUMED percent
 * (the family convention), the credit balances ride beside them as plain USD
 * figures. A missing meter is absent, never zeroed.
 */
export function bodyFromAmpMeters(meters: AmpUsageMeters): string {
  const windows: Array<{ id: string; percent: number; resetsAt: number | null }> = []
  if (meters.freeRemainingPercent != null) {
    windows.push({ id: 'ampFree', percent: clampPercent(100 - meters.freeRemainingPercent), resetsAt: null })
  }
  if (meters.subscriptionOtherRemainingPercent != null || meters.subscriptionOrbRemainingPercent != null) {
    if (meters.subscriptionOtherRemainingPercent != null) {
      windows.push({
        id: 'ampSubscriptionOther',
        percent: clampPercent(100 - meters.subscriptionOtherRemainingPercent),
        resetsAt: meters.subscriptionResetsAt,
      })
    }
    if (meters.subscriptionOrbRemainingPercent != null) {
      windows.push({
        id: 'ampSubscriptionOrb',
        percent: clampPercent(100 - meters.subscriptionOrbRemainingPercent),
        resetsAt: meters.subscriptionResetsAt,
      })
    }
  }
  return JSON.stringify({
    plan: meters.plan,
    windows,
    topUpCredits: meters.individualCreditsUsd,
    workspaceCredits: meters.workspaceCreditsUsd,
    stale: false,
  })
}

/**
 * Run `amp usage` once. Resolve (never reject) with the captured result so a
 * missing binary and a failed run flow through the same honest-degrade path.
 */
export function runAmpUsageCli(): Promise<AmpCliResult> {
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let settled = false
    // npm-global installs land as amp.cmd / amp.ps1 on Windows, which
    // CreateProcess cannot start directly — route through cmd.exe with fixed
    // arguments so both a native amp.exe and the npm shim resolve. argv is
    // constant, so the shell adds no injection surface.
    const child =
      process.platform === 'win32'
        ? spawn('cmd.exe', ['/c', 'amp', 'usage'], { windowsHide: true })
        : spawn('amp', ['usage'], { windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill()
      resolve({ code: null, out, err, missing: false, timedOut: true })
    }, CLI_TIMEOUT_MS)
    // Cap the capture: a runaway CLI must not grow the main-process heap
    // without bound; absurd output parses to fail-closed anyway.
    const CAP_BYTES = 256 * 1024
    child.stdout.on('data', (d: Buffer) => {
      if (out.length < CAP_BYTES) out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      if (err.length < CAP_BYTES) err += d.toString()
    })
    child.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // ENOENT or a shim the process cannot execute: both read as "no CLI".
      resolve({ code: null, out, err, missing: true, timedOut: false })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, out, err, missing: false, timedOut: false })
    })
  })
}

/**
 * Amp balance from the CLI's own reading. A missing CLI is the honest
 * no-auth state; a sheet no meter can be parsed from fails closed rather than
 * inventing zeros. A non-zero exit with parseable output is still accepted —
 * tokscale's precedent: complete output beats a late panic.
 */
export async function fetchAmpUsage(runner: AmpUsageRunner = runAmpUsageCli): Promise<QuotaOutcome> {
  try {
    const result = await runner()
    if (result.missing) return { available: false, reason: 'no-auth' }
    if (result.timedOut) return { available: false, reason: 'timeout' }
    const meters = parseAmpUsageText(result.out)
    if (!meters) return { available: false, reason: 'parse-failed' }
    return { available: true, body: bodyFromAmpMeters(meters) }
  } catch {
    return { available: false, reason: 'probe-failed' }
  }
}
