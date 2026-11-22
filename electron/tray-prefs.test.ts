import { describe, expect, it } from 'vitest'
import { guessLocale, mergeTrayPrefs, type TrayPrefs } from './tray-prefs'

const BASE: TrayPrefs = { locale: 'en-US', theme: 'dark' }

describe('guessLocale', () => {
  it('maps zh-prefixed OS locales to zh-CN', () => {
    expect(guessLocale('zh-CN')).toBe('zh-CN')
    expect(guessLocale('zh_TW')).toBe('zh-CN')
  })

  it('falls back to en-US otherwise', () => {
    expect(guessLocale('en-US')).toBe('en-US')
    expect(guessLocale('fr-FR')).toBe('en-US')
    expect(guessLocale('')).toBe('en-US')
  })
})

describe('mergeTrayPrefs', () => {
  it('applies a full valid patch', () => {
    expect(mergeTrayPrefs(BASE, { locale: 'zh-CN', theme: 'system' })).toEqual({
      locale: 'zh-CN',
      theme: 'system',
    })
  })

  it('applies partial patches without clobbering the other field', () => {
    expect(mergeTrayPrefs(BASE, { locale: 'zh-CN' })).toEqual({ locale: 'zh-CN', theme: 'dark' })
    expect(mergeTrayPrefs(BASE, { theme: 'light' })).toEqual({ locale: 'en-US', theme: 'light' })
  })

  it('ignores invalid values instead of failing the push', () => {
    expect(mergeTrayPrefs(BASE, { locale: 'fr-FR', theme: 'auto' })).toEqual(BASE)
  })

  it('keeps the current prefs for non-object or empty patches', () => {
    expect(mergeTrayPrefs(BASE, null)).toEqual(BASE)
    expect(mergeTrayPrefs(BASE, 'dark')).toEqual(BASE)
    expect(mergeTrayPrefs(BASE, {})).toEqual(BASE)
    expect(mergeTrayPrefs(BASE, { unrelated: true })).toEqual(BASE)
  })
})
