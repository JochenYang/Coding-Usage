/**
 * Renderer-side wrapper over the main process's usage history store.
 *
 * The store itself lives in the main process (electron/usage-store.ts): the
 * renderer runs sandboxed with no filesystem access, so every read and write
 * crosses the IPC bridge. Both helpers degrade to null in the browser build,
 * where the history does not exist — the settings page hides the section rather
 * than offering a control that cannot work.
 */

/** Range covered by the stored history, or null when unavailable (browser build) */
export async function getUsageHistoryStats(): Promise<UsageHistoryStats | null> {
  const bridge = window.desktopBridge
  if (!bridge) return null
  try {
    return await bridge.usageStats()
  } catch {
    return null
  }
}

/**
 * Trim the stored history. `null` wipes it; a positive number keeps the last N
 * days. Returns what was removed plus the remaining range, or null when the
 * call failed (nothing is changed in that case).
 */
export async function purgeUsageHistory(
  beforeDays: number | null,
): Promise<UsageHistoryPurgeResult | null> {
  const bridge = window.desktopBridge
  if (!bridge) return null
  try {
    return await bridge.usagePurge(beforeDays)
  } catch {
    return null
  }
}
