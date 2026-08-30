/**
 * Currency conversion for display amounts. The live rate table (fetched by
 * data-context from open.er-api.com and cached in localStorage) takes
 * priority; the static table below is the offline floor so conversion always
 * works — rates are "1 unit of currency in CNY", pivoting through CNY.
 */

const FALLBACK_RATES: Record<string, number> = {
  CNY: 1,
  USD: 7.16,
  HKD: 0.92,
  TWD: 0.23,
}

/** Currencies offered in the settings picker (display list, not a limit) */
export const KNOWN_CURRENCIES = Object.keys(FALLBACK_RATES)

export type FxRates = Record<string, number>

/**
 * Convert `amount` from `from` into `display` via the CNY pivot. Returns null
 * when either currency is unknown in the active table — callers must render a
 * placeholder instead of guessing a rate.
 */
export function convertAmount(
  amount: number,
  from: string,
  display: string,
  rates?: FxRates | null,
): number | null {
  const table = rates && Object.keys(rates).length > 0 ? rates : FALLBACK_RATES
  const fromRate = table[from.toUpperCase()]
  const displayRate = table[display.toUpperCase()]
  if (fromRate == null || displayRate == null) return null
  return (amount * fromRate) / displayRate
}

/** True when the currency appears in the active rate table */
export function isKnownCurrency(code: string, rates?: FxRates | null): boolean {
  const table = rates && Object.keys(rates).length > 0 ? rates : FALLBACK_RATES
  return table[code.toUpperCase()] != null
}

/**
 * Normalize an open.er-api.com `/latest/USD` payload into the CNY-pivot
 * table: every currency gets "1 X = ? CNY" (rates.CNY / rates.X). Returns
 * null on any shape mismatch — the caller then falls back to the static table.
 */
export function normalizeOpenErRates(json: unknown): FxRates | null {
  if (!json || typeof json !== 'object') return null
  const root = json as { result?: unknown; rates?: Record<string, unknown> }
  if (root.result !== 'success' || !root.rates) return null
  const usd = root.rates
  const cnyPerUsd = usd.CNY
  if (typeof cnyPerUsd !== 'number' || !Number.isFinite(cnyPerUsd) || cnyPerUsd <= 0) return null
  const out: FxRates = { CNY: 1, USD: cnyPerUsd }
  for (const [code, perUsd] of Object.entries(usd)) {
    if (code === 'CNY' || code === 'USD') continue
    if (typeof perUsd === 'number' && Number.isFinite(perUsd) && perUsd > 0) {
      out[code] = cnyPerUsd / perUsd
    }
  }
  return out
}
