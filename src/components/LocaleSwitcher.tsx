import { Globe } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './beui/select'
import { useLocale } from '../i18n/LocaleProvider'
import { LOCALES, type Locale } from '../i18n/types'

// Display names for each locale in its OWN language: '中文' for zh-CN, 'English' for en-US.
// Kept as a small constant here rather than going through the dict since it's
// inherently self-referential (a locale labels itself).
const LABELS: Record<Locale, string> = {
  'zh-CN': '中文',
  'en-US': 'English',
}

/**
 * Compact language switcher using the beui Select primitive.
 * - Calls `useLocale().setLocale`; the provider persists to localStorage
 *   and syncs `<html lang>` so screen readers and CSS `:lang(...)` selectors follow.
 * - Mounted inside Header (between refresh-all and theme buttons).
 */
export function LocaleSwitcher({ className }: { className?: string }) {
  const { locale, setLocale } = useLocale()

  return (
    <Select value={locale} onValueChange={(v) => setLocale(v as Locale)}>
      <SelectTrigger
        aria-label="Language"
        className={
          'flex w-auto items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted' +
          (className ? ` ${className}` : '')
        }
      >
        <Globe className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Language</span>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {LOCALES.map((l) => (
          <SelectItem key={l} value={l}>
            {LABELS[l]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}