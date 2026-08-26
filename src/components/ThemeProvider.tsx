import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'
import type { ReactNode } from 'react'

/** 用户在 UI 上选择的主题模式 */
export type ThemeMode = 'light' | 'dark' | 'system'
/** 实际生效的主题（system 模式会再解析为 light 或 dark） */
export type ResolvedTheme = 'light' | 'dark'

interface ThemeContextValue {
  theme: ThemeMode
  setTheme: (t: ThemeMode) => void
  resolved: ResolvedTheme
}

const STORAGE_KEY = 'coding-usage.theme.v1'
const ThemeContext = createContext<ThemeContextValue | null>(null)

/** lazy 读取 localStorage，避免 SSR / 同步首屏读不到 storage 时给出错误初始值。
 *  无存储记录时默认深色（桌面壳的设计基准），而非跟随系统。 */
function readStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark'
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    // localStorage 可能被禁用（隐私模式 / 配额异常），退回默认
  }
  return 'dark'
}

function getSystemPref(): ResolvedTheme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'light'
  // Multi-signal fusion: prefer the standard `prefers-color-scheme`, but also
  // honour legacy `prefers-color` and Firefox's `-moz-prefers-color` so a
  // browser that reports only the older API still drives the theme correctly.
  const signals = [
    window.matchMedia('(prefers-color-scheme: dark)').matches,
    window.matchMedia('(prefers-color: dark)').matches,
    window.matchMedia('(-moz-prefers-color: dark)').matches,
  ]
  return signals.some(Boolean) ? 'dark' : 'light'
}

function applyResolvedToDom(resolved: ResolvedTheme): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  if (resolved === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeMode>(() => readStoredTheme())
  const [systemResolved, setSystemResolved] = useState<ResolvedTheme>(() => getSystemPref())

  // 仅在 system 模式下关注系统偏好的变化
  useEffect(() => {
    if (theme !== 'system') return
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = (e: MediaQueryListEvent) => {
      setSystemResolved(e.matches ? 'dark' : 'light')
    }
    // 兼容新旧 API：现代浏览器 addEventListener，旧 Safari 用 addListener
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
    // effect 跑的时候再校准一次，防止 init 与监听挂载之间偏好已变
    setSystemResolved(mql.matches ? 'dark' : 'light')
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [theme])

  const resolved: ResolvedTheme = theme === 'system' ? systemResolved : theme

  // 把 resolved 同步到 <html class="dark">
  useEffect(() => {
    applyResolvedToDom(resolved)
    // Keep the Electron title-bar overlay on the same colors as the app theme
    window.desktopBridge?.setWindowTheme(resolved)
  }, [resolved])

  // Favicon: always follow the OS/browser `prefers-color-scheme` so the icon
  // stays visible regardless of the app's manual theme override.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const updateFavicon = (dark: boolean) => {
      const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
      if (!link) return
      const stroke = dark ? '%23ffffff' : '%23000000'
      link.href = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='${stroke}' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M3 3v18h18'/%3E%3Cpath d='M7 16V9'/%3E%3Cpath d='M12 16v-4'/%3E%3Cpath d='M17 16V6'/%3E%3C/svg%3E`
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    updateFavicon(mql.matches)
    const onChange = (e: MediaQueryListEvent) => updateFavicon(e.matches)
    if (mql.addEventListener) mql.addEventListener('change', onChange)
    else mql.addListener(onChange)
    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', onChange)
      else mql.removeListener(onChange)
    }
  }, [])

  const setTheme = useCallback((t: ThemeMode) => {
    setThemeState(t)
    try {
      window.localStorage.setItem(STORAGE_KEY, t)
    } catch {
      // 配额满 / 隐私模式写不进去，状态仍然在内存里
    }
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme, resolved }),
    [theme, setTheme, resolved],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within <ThemeProvider>')
  return ctx
}