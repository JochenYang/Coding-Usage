import type { AlertThresholds, IntegrationsSettings, ProviderConfig, Settings } from '../types'
import { resolveThresholds } from './alerts'
import { isKnownSubscriptionKey } from './subscription-cards'
import {
  normalizeProviders,
  subscriptionKeyRenamer,
  subscriptionKeysVersionOf,
  SUBSCRIPTION_KEYS_VERSION,
  type ProviderSplit,
} from './storage'

/**
 * Settings-backup import: read a backup document and merge it over the
 * current settings. Pure, so the whole route a backup takes — including the
 * accounts of a backup written before the split-site providers were split —
 * can be tested without mounting the settings page.
 */

/** A backup document after validation. A null field means "absent: keep the current value". */
export interface ImportedSettings {
  providers: Record<string, ProviderConfig[]>
  /** What moving pre-split accounts did; the history import needs its key rename */
  split: ProviderSplit
  autoRefreshMin: number | null
  displayCurrency: string | null
  integrations: IntegrationsSettings | null
  alertThresholds: AlertThresholds | null
  planOrder: string[] | null
  subscriptionOrder: string[] | null
  enabledSubscriptions: string[] | null
}

/**
 * Validate a raw settings payload. Returns null when the providers record is
 * missing or malformed, so there is nothing to import.
 *
 * The providers go through the same entry point as the startup load, which
 * is what moves the accounts of a backup taken before the split-site
 * providers were split. Skipping that here would hand an international
 * account's key to the China host, and saving the account would make it
 * permanent. The other fields follow the startup rules too, but they carry
 * no account routing, so they are read in place.
 */
export function readImportedSettings(raw: unknown): ImportedSettings | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const obj = raw as Record<string, unknown>
  if (!obj.providers || typeof obj.providers !== 'object' || Array.isArray(obj.providers)) return null

  const { providers, split } = normalizeProviders(obj.providers)
  const rawIntg = obj.integrations as Partial<IntegrationsSettings> | undefined
  const integrations: IntegrationsSettings | null =
    rawIntg && typeof rawIntg === 'object' && typeof rawIntg.wecomWebhook === 'string'
      ? {
          alertPush: rawIntg.alertPush === true,
          wecomWebhook: rawIntg.wecomWebhook,
          feishuWebhook: typeof rawIntg.feishuWebhook === 'string' ? rawIntg.feishuWebhook : '',
          feishuSecret: typeof rawIntg.feishuSecret === 'string' ? rawIntg.feishuSecret : '',
          dingtalkWebhook: typeof rawIntg.dingtalkWebhook === 'string' ? rawIntg.dingtalkWebhook : '',
          dingtalkSecret: typeof rawIntg.dingtalkSecret === 'string' ? rawIntg.dingtalkSecret : '',
          discordWebhook: typeof rawIntg.discordWebhook === 'string' ? rawIntg.discordWebhook : '',
          slackWebhook: typeof rawIntg.slackWebhook === 'string' ? rawIntg.slackWebhook : '',
          barkServer: typeof rawIntg.barkServer === 'string' ? rawIntg.barkServer : '',
          barkKey: typeof rawIntg.barkKey === 'string' ? rawIntg.barkKey : '',
          ntfyServer: typeof rawIntg.ntfyServer === 'string' ? rawIntg.ntfyServer : '',
          ntfyTopic: typeof rawIntg.ntfyTopic === 'string' ? rawIntg.ntfyTopic : '',
          telegramBotToken: typeof rawIntg.telegramBotToken === 'string' ? rawIntg.telegramBotToken : '',
          telegramChatId: typeof rawIntg.telegramChatId === 'string' ? rawIntg.telegramChatId : '',
          weixinBotToken: typeof rawIntg.weixinBotToken === 'string' ? rawIntg.weixinBotToken : '',
          weixinBotUserId: typeof rawIntg.weixinBotUserId === 'string' ? rawIntg.weixinBotUserId : '',
        }
      : null
  // A backup taken before the Antigravity cards were split holds `antigravity`
  // as the IDE card; one taken since holds it as the app card. The document's
  // own key-set version tells them apart. Renaming comes before the filter on
  // purpose: both keys are valid now, so the filter alone would pass the old
  // key through as the app card.
  const renameKeys = subscriptionKeyRenamer(obj)
  return {
    providers,
    split,
    autoRefreshMin: typeof obj.autoRefreshMin === 'number' ? obj.autoRefreshMin : null,
    displayCurrency: typeof obj.displayCurrency === 'string' ? obj.displayCurrency : null,
    integrations,
    alertThresholds: obj.alertThresholds != null ? resolveThresholds(obj.alertThresholds) : null,
    // null (absent) rather than [] so an older export keeps the local order
    planOrder: Array.isArray(obj.planOrder)
      ? obj.planOrder.filter((key): key is string => typeof key === 'string')
      : null,
    subscriptionOrder: Array.isArray(obj.subscriptionOrder)
      ? renameKeys(obj.subscriptionOrder.filter((key): key is string => typeof key === 'string'))
      : null,
    enabledSubscriptions: Array.isArray(obj.enabledSubscriptions)
      ? renameKeys(obj.enabledSubscriptions.filter((key): key is string => typeof key === 'string')).filter(
          isKnownSubscriptionKey,
        )
      : null,
  }
}

/**
 * Lay an imported backup over the current settings. Imported fields win;
 * absent scalars keep theirs. A provider listed in the backup replaces the
 * local list wholesale — accounts are not interleaved — while a provider the
 * backup does not mention is left alone.
 */
export function mergeImportedSettings(current: Settings, imported: ImportedSettings): Settings {
  return {
    providers: { ...current.providers, ...imported.providers },
    autoRefreshMin: imported.autoRefreshMin ?? current.autoRefreshMin,
    displayCurrency: imported.displayCurrency ?? current.displayCurrency,
    usageDisplayMode: current.usageDisplayMode,
    desktopIsland: current.desktopIsland,
    integrations: imported.integrations ?? current.integrations,
    alertThresholds: imported.alertThresholds ?? current.alertThresholds,
    // An export made before the order existed carries no list; keeping null
    // distinct from [] is what lets it leave the local order alone.
    planOrder: imported.planOrder && imported.planOrder.length > 0 ? imported.planOrder : current.planOrder,
    subscriptionOrder:
      imported.subscriptionOrder && imported.subscriptionOrder.length > 0
        ? imported.subscriptionOrder
        : current.subscriptionOrder,
    // null (absent) keeps the local selection; an explicitly empty list is
    // also treated as "keep" because every other list field behaves that way
    // and a fresh install's export must not wipe a configured machine.
    enabledSubscriptions:
      imported.enabledSubscriptions && imported.enabledSubscriptions.length > 0
        ? imported.enabledSubscriptions
        : current.enabledSubscriptions,
    // The backup's keys are already renamed to the current set above, so the
    // merged document belongs to the current version — never lower, whatever
    // the current document said, and never the backup's, which may predate it.
    // Read through subscriptionKeysVersionOf on purpose: a current document
    // built without the field must not turn Math.max into NaN, which JSON
    // would store as null and the next load would read as "pre-split".
    subscriptionKeysVersion: Math.max(subscriptionKeysVersionOf(current), SUBSCRIPTION_KEYS_VERSION),
  }
}
