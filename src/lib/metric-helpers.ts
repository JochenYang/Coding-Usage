/**
 * Sentinel token for the unlimited metric state.
 *
 * The minimax adapter stamps this value into `UsageMetric.unit` when a window
 * has total=0 (owner-side unlimited quota). `MetricList` then compares
 * `metric.unit === UNLIMITED_KEY` to render the full-green progress bar.
 *
 * Kept as a shared constant so both sides reference the same byte sequence;
 * the rendered label itself comes from `t.metric.unlimited` (locale-aware).
 * A `kind` discriminator would be cleaner but would require touching every
 * adapter's `parseResponse` — out of scope for this wave.
 */
export const UNLIMITED_KEY = '无限'