import { useLocale } from './LocaleProvider'

/** 便捷 hook：只取字典部分 */
export function useT() {
  const { t } = useLocale()
  return t
}