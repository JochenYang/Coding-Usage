/**
 * Tray-menu preferences synced from the renderer (`prefs:tray-sync` IPC).
 * The renderer owns both settings (localStorage in ThemeProvider /
 * LocaleProvider), so the main process starts from a guess and converges on
 * the renderer's first push.
 */

export type TrayLocale = 'zh-CN' | 'en-US'
export type TrayThemeSource = 'light' | 'dark' | 'system'

export interface TrayPrefs {
  locale: TrayLocale
  theme: TrayThemeSource
}

export const TRAY_LOCALES = ['zh-CN', 'en-US'] as const
export const TRAY_THEMES = ['light', 'dark', 'system'] as const

/**
 * Tray-menu copy, bilingual and deliberately tiny: the renderer's dict is a
 * TSX-heavy module tree not worth pulling into the main bundle.
 */
export const TRAY_LABELS: Record<TrayLocale, { show: string; quit: string }> = {
  'zh-CN': { show: '显示主窗口', quit: '退出' },
  'en-US': { show: 'Show', quit: 'Quit' },
}

/** Initial locale before the renderer's first sync arrives. */
export function guessLocale(osLocale: string): TrayLocale {
  return osLocale.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en-US'
}

/**
 * Merge a renderer push into the current prefs. IPC input is untrusted, so
 * every field is validated against its union; unknown or invalid values are
 * ignored rather than failing the whole push, and only fields actually present
 * on the patch are touched (LocaleProvider sends `{locale}` alone,
 * ThemeProvider `{theme}`, so a partial push never clobbers the other field).
 */
export function mergeTrayPrefs(current: TrayPrefs, patch: unknown): TrayPrefs {
  if (typeof patch !== 'object' || patch === null) return current
  const p = patch as Record<string, unknown>
  const locale = TRAY_LOCALES.find((l) => l === p.locale)
  const theme = TRAY_THEMES.find((t) => t === p.theme)
  if (!locale && !theme) return current
  return {
    locale: locale ?? current.locale,
    theme: theme ?? current.theme,
  }
}
