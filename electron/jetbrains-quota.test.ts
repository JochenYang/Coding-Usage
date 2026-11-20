import { mkdir, mkdtemp, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { fetchJetBrainsQuota, jetbrainsLogPath, quotaFromLog, quotaFromXml } from './jetbrains-quota'

const XML = `<?xml version="1.0"?>
<application>
  <component name="AIAssistantQuotaManager2">
    <option name="quotaInfo" value="{&quot;type&quot;:&quot;Available&quot;,&quot;current&quot;:&quot;999&quot;,&quot;maximum&quot;:&quot;999&quot;,&quot;tariffQuota&quot;:{&quot;current&quot;:&quot;200000&quot;,&quot;maximum&quot;:&quot;1000000&quot;,&quot;available&quot;:&quot;800000&quot;},&quot;topUpQuota&quot;:{&quot;current&quot;:&quot;0&quot;,&quot;maximum&quot;:&quot;500000&quot;,&quot;available&quot;:&quot;500000&quot;}}" />
    <option name="nextRefill" value="{&quot;type&quot;:&quot;Known&quot;,&quot;next&quot;:&quot;2026-05-01T00:00:00Z&quot;}" />
  </component>
</application>
`

describe('JetBrains quota XML', () => {
  it('uses the monthly tariff and keeps top-up credits out of the percentage', () => {
    const quota = quotaFromXml(XML)
    expect(quota).toEqual({
      used: 200000,
      maximum: 1000000,
      topUpCredits: 5,
      resetsAt: Date.parse('2026-05-01T00:00:00Z'),
    })
  })

  it('falls back to the top-level pair only when the tariff pair is incomplete', () => {
    const xml = `<component name="AIAssistantQuotaManager2"><option name="quotaInfo" value="{&quot;current&quot;:&quot;3&quot;,&quot;maximum&quot;:&quot;10&quot;,&quot;tariffQuota&quot;:{&quot;current&quot;:&quot;1&quot;}}" /></component>`
    expect(quotaFromXml(xml)).toMatchObject({ used: 3, maximum: 10, topUpCredits: null })
  })

  it('does not invent a window from a zero maximum', () => {
    const xml = `<component name="AIAssistantQuotaManager2"><option name="quotaInfo" value="{&quot;current&quot;:&quot;0&quot;,&quot;maximum&quot;:&quot;0&quot;}" /></component>`
    expect(quotaFromXml(xml)).toBeNull()
  })
})

describe('JetBrains quota log', () => {
  it('reads the newest Available record and its refill', () => {
    const log = [
      '2026-04-01 09:00:00,000 INFO - QuotaManager2Impl - New quota state is: Available(current=1, maximum=10, until=2026-05-01T00:00:00Z, tariffQuota=QuotaDetails(current=1, maximum=10, available=9))',
      '2026-04-02 10:00:00,000 INFO - QuotaManager2Impl - New quota refill state is: Known(next=2026-05-01T00:00:00Z, tariff=QuotaRefillInfoTariff(amount=10, duration=PT720H))',
      '2026-04-02 10:00:01,000 INFO - QuotaManager2Impl - New quota state is: Available(current=4, maximum=10, until=2026-05-01T00:00:00Z, tariffQuota=QuotaDetails(current=4, maximum=10, available=6), topUpQuota=QuotaDetails(current=0, maximum=200000, available=100000))',
      '',
    ].join('\n')
    const parsed = quotaFromLog(log)
    expect(parsed?.quota).toMatchObject({ used: 4, maximum: 10, topUpCredits: 1 })
    expect(parsed?.quota.resetsAt).toBe(Date.parse('2026-05-01T00:00:00Z'))
  })

  it('skips a disabled-assistant error and rejects an unrecognized latest record', () => {
    const skipped = [
      '2026-04-02 10:00:00,000 INFO - QuotaManager2Impl - New quota state is: Available(current=2, maximum=8, until=2026-05-01T00:00:00Z, tariffQuota=QuotaDetails(current=2, maximum=8, available=6))',
      '2026-04-03 10:00:00,000 INFO - QuotaManager2Impl - New quota state is: Error(exception=com.intellij.ml.llm.core.AIAssistantForbiddenException: Air)',
      '',
    ].join('\n')
    expect(quotaFromLog(skipped)?.quota.used).toBe(2)
    const bad = [
      '2026-04-02 10:00:00,000 INFO - QuotaManager2Impl - New quota state is: Available(current=2, maximum=8, until=2026-05-01T00:00:00Z, tariffQuota=QuotaDetails(current=2, maximum=8, available=6))',
      '2026-04-03 10:00:00,000 INFO - QuotaManager2Impl - New quota state is: Error(exception=other)',
      '',
    ].join('\n')
    expect(quotaFromLog(bad)).toBeNull()
  })

  it('reads a Junie quota_update without treating until as a reset', () => {
    const line =
      '2026-04-02 10:00:00,000 INFO - AiaActivationTransmitter - Received message from junie: quota_update:{"until":1777593600000,"tariffQuota":{"current":{"amount":"2"},"maximum":{"amount":"10"},"available":{"amount":"8"}}}\n'
    expect(quotaFromLog(line)?.quota).toMatchObject({ used: 2, maximum: 10, resetsAt: null })
  })
})

describe('fetchJetBrainsQuota', () => {
  it('prefers a newer log from the same installation and ignores another IDE', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jb-home-'))
    const appData = await mkdtemp(join(tmpdir(), 'jb-app-'))
    const local = await mkdtemp(join(tmpdir(), 'jb-local-'))
    const idea = join(appData, 'JetBrains', 'IntelliJIdea2025.3', 'options')
    const other = join(appData, 'JetBrains', 'PyCharm2025.3', 'options')
    await mkdir(idea, { recursive: true })
    await mkdir(other, { recursive: true })
    const xmlPath = join(idea, 'AIAssistantQuotaManager2.xml')
    await writeFile(xmlPath, XML)
    await utimes(xmlPath, new Date('2026-04-01T00:00:00Z'), new Date('2026-04-01T00:00:00Z'))
    const otherXml = join(other, 'AIAssistantQuotaManager2.xml')
    await writeFile(
      otherXml,
      `<component name="AIAssistantQuotaManager2"><option name="quotaInfo" value="{&quot;current&quot;:&quot;9&quot;,&quot;maximum&quot;:&quot;10&quot;}" /></component>`,
    )
    // Newer than IntelliJ's XML, older than IntelliJ's log. The log must still win.
    await utimes(otherXml, new Date('2026-04-02T00:00:00Z'), new Date('2026-04-02T00:00:00Z'))
    const logDir = join(local, 'JetBrains', 'IntelliJIdea2025.3', 'log')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, 'idea.log'),
      '2026-04-03 12:00:00,000 INFO - QuotaManager2Impl - New quota state is: Available(current=1, maximum=10, until=2026-05-01T00:00:00Z, tariffQuota=QuotaDetails(current=1, maximum=10, available=9))\n',
    )
    const outcome = await fetchJetBrainsQuota(home, { APPDATA: appData, LOCALAPPDATA: local })
    const body = JSON.parse(outcome.body ?? '{}')
    expect(body.plan).toBe('IntelliJ IDEA 2025.3')
    expect(body.windows[0].percent).toBe(10)
    expect(
      jetbrainsLogPath(join(appData, 'JetBrains', 'IntelliJIdea2025.3'), home, { APPDATA: appData, LOCALAPPDATA: local }),
    ).toBe(join(local, 'JetBrains', 'IntelliJIdea2025.3', 'log', 'idea.log'))
    expect(jetbrainsLogPath(join(home, '.config', 'JetBrains', 'IntelliJIdea2025.3'), home, { LOCALAPPDATA: local })).toBe(
      join(home, '.cache', 'JetBrains', 'IntelliJIdea2025.3', 'log', 'idea.log'),
    )
  })

  it('does not replace an unreadable XML with an older log', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jb-bad-'))
    const appData = await mkdtemp(join(tmpdir(), 'jb-bad-app-'))
    const local = await mkdtemp(join(tmpdir(), 'jb-bad-local-'))
    const idea = join(appData, 'JetBrains', 'IntelliJIdea2025.3', 'options')
    await mkdir(idea, { recursive: true })
    const xmlPath = join(idea, 'AIAssistantQuotaManager2.xml')
    await writeFile(xmlPath, '<component name="AIAssistantQuotaManager2"></component>')
    await utimes(xmlPath, new Date('2026-04-04T00:00:00Z'), new Date('2026-04-04T00:00:00Z'))
    const logDir = join(local, 'JetBrains', 'IntelliJIdea2025.3', 'log')
    await mkdir(logDir, { recursive: true })
    await writeFile(
      join(logDir, 'idea.log'),
      '2026-04-01 12:00:00,000 INFO - QuotaManager2Impl - New quota state is: Available(current=1, maximum=10, until=2026-05-01T00:00:00Z, tariffQuota=QuotaDetails(current=1, maximum=10, available=9))\n',
    )
    expect(await fetchJetBrainsQuota(home, { APPDATA: appData, LOCALAPPDATA: local })).toEqual({
      available: false,
      reason: 'parse-failed',
    })
  })

  it('reports no-auth when no IDE quota is present', async () => {
    const home = await mkdtemp(join(tmpdir(), 'jb-empty-'))
    const appData = await mkdtemp(join(tmpdir(), 'jb-empty-app-'))
    expect(await fetchJetBrainsQuota(home, { APPDATA: appData, LOCALAPPDATA: appData })).toEqual({
      available: false,
      reason: 'no-auth',
    })
  })
})
