import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { zhCN } from './dict.zh-CN'
import { enUS } from './dict.en-US'
import { DEFAULT_LOCALE, LOCALES, type Dict, type Locale } from './types'

const STORAGE_KEY = 'coding-usage.locale.v1'

type LocaleContextValue = {
  locale: Locale
  setLocale: (l: Locale) => void
  t: Dict
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value)
}

function loadInitialLocale(): Locale {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw && isLocale(raw)) return raw
  } catch {
    // ignore (SSR / privacy mode 等)
  }
  return DEFAULT_LOCALE
}

const DICTS: Record<Locale, Dict> = {
  'zh-CN': zhCN,
  'en-US': enUS,
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(loadInitialLocale)

  // 副作用：把 locale 同步到 <html lang="..."> + document.title (browser tab title)
  useEffect(() => {
    if (typeof document === 'undefined') return
    document.documentElement.lang = locale
    const t = DICTS[locale]
    document.title = `${t.app.title} · ${t.app.tagline}`
  }, [locale])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(STORAGE_KEY, next)
    } catch {
      // ignore
    }
  }, [])

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: DICTS[locale] }),
    [locale, setLocale],
  )

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext)
  if (!ctx) {
    throw new Error('useLocale must be used within <LocaleProvider>')
  }
  return ctx
}