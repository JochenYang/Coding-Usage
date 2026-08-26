/** Static reference rates expressed as "1 unit of currency in CNY".
 *  A live-rate feed is out of scope; the settings page (management phase)
 *  will expose these for manual editing. Keys are uppercase currency codes. */
const TO_CNY: Record<string, number> = {
  CNY: 1,
  USD: 7.16,
  HKD: 0.92,
  TWD: 0.23,
}

export type Currency = keyof typeof TO_CNY

/** Currencies we can render a converted total for */
export const KNOWN_CURRENCIES = Object.keys(TO_CNY) as Currency[]

/**
 * Convert `amount` from `from` currency into `display` currency via the CNY
 * pivot. Returns null when either currency is unknown — callers must render a
 * placeholder instead of guessing a rate.
 */
export function convertAmount(
  amount: number,
  from: string,
  display: string,
): number | null {
  const fromRate = TO_CNY[from.toUpperCase()]
  const displayRate = TO_CNY[display.toUpperCase()]
  if (fromRate == null || displayRate == null) return null
  return (amount * fromRate) / displayRate
}

/** True when the currency appears in the rate table */
export function isKnownCurrency(code: string): boolean {
  return TO_CNY[code.toUpperCase()] != null
}
