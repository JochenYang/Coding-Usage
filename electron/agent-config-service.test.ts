import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readAgentConfig, removeAgentProvider, revealAgentKey, saveAgentProvider } from './agent-config-service'

/**
 * The service is the chain the renderer actually drives: locate the file, read
 * a snapshot, parse, transform, serialise, write with compare-and-swap. These
 * tests run the whole chain against a fake home directory so the CAS token, the
 * drift refusal and the backup-before-overwrite promise are verified end to
 * end — per-agent parser quirks are covered in the kimi-config / mcode-config /
 * opencode-config tests.
 */

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => state.home }
})

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

beforeEach(async () => {
  state.home = await tempDir('agent-config-service-home-')
})

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Install one agent's config file at the location the path probe expects */
async function install(agent: 'kimi' | 'mcode' | 'opencode', text: string): Promise<string> {
  const path =
    agent === 'kimi'
      ? join(state.home, '.kimi-code', 'config.toml')
      : agent === 'mcode'
        ? join(state.home, '.minimax', 'config.yaml')
        : join(state.home, '.config', 'opencode', 'opencode.json')
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, text, 'utf8')
  return path
}

const KIMI_TOML = `default_model = "acme/m1"
default_provider = "acme"
default_permission_mode = "ask"

[providers.acme]
type = "openai"
base_url = "https://api.acme.dev/v1"
api_key = "sk-acme-0001112222"

[providers.other]
type = "anthropic"
api_key = "sk-other-key"

[models."acme/m1"]
model = "m1"
provider = "acme"

[models."other/o1"]
model = "o1"
provider = "other"

[experimental]
flag = true
`

describe('readAgentConfig', () => {
  it('returns the parsed payload with the CAS revision of the exact text', async () => {
    const path = await install('kimi', KIMI_TOML)
    const payload = await readAgentConfig('kimi')
    expect(payload.installed).toBe(true)
    expect(payload.configPath).toBe(path)
    expect(payload.revision).not.toBe('')
    expect(payload.providers.map((p) => p.id)).toEqual(['acme', 'other'])
    expect(payload.providers.find((p) => p.id === 'acme')?.hasKey).toBe(true)
  })

  it('degrades to a not-installed payload when no config file exists', async () => {
    const payload = await readAgentConfig('opencode')
    expect(payload.installed).toBe(false)
    expect(payload.configPath).toBeNull()
    expect(payload.note).toBe('not-found')
    expect(payload.providers).toEqual([])
  })

  it('reports a parse failure with the parser message and keeps the path', async () => {
    await install('kimi', 'this is not [valid toml\n')
    const payload = await readAgentConfig('kimi')
    expect(payload.installed).toBe(false)
    expect(payload.configPath).not.toBeNull()
    expect(payload.note?.startsWith('parse-error: ')).toBe(true)
  })
})

describe('saveAgentProvider', () => {
  const input = {
    id: 'new-relay',
    name: 'New Relay',
    protocol: 'openai',
    baseUrl: 'https://relay.example.com/v1',
    apiKey: 'sk-new-relay-9999',
    models: [{ id: 'm1' }],
  }

  it('writes the provider through the chain and produces a backup', async () => {
    const path = await install('kimi', KIMI_TOML)
    const outcome = await saveAgentProvider('kimi', '', input)
    expect(outcome.ok).toBe(true)
    const backupPath = outcome.ok ? outcome.backupPath : ''
    expect(backupPath).not.toBe('')
    await expect(readFile(backupPath!, 'utf8')).resolves.toBe(KIMI_TOML)
    const text = await readFile(path, 'utf8')
    expect(text).toContain('[providers.new-relay]')
    // The untouched provider section survived the rewrite.
    expect(text).toContain('sk-acme-0001112222')
    expect(text).toContain('[providers.other]')
  })

  it('refuses a stale revision with a drift message instead of clobbering', async () => {
    await install('kimi', KIMI_TOML)
    const payload = await readAgentConfig('kimi')
    // The agent rewrites its file between the read and the save.
    await install('kimi', `${KIMI_TOML}\n[extra]\nchanged = true\n`)
    const outcome = await saveAgentProvider('kimi', payload.revision, input)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('conflict')
    expect(outcome.message).toContain('外部修改')
  })

  it('validates the input before touching the file', async () => {
    const path = await install('kimi', KIMI_TOML)
    const before = await readFile(path, 'utf8')

    const quoted = await saveAgentProvider('kimi', '', { ...input, id: 'bad"quote' })
    expect(quoted.reason).toBe('invalid')
    const protocol = await saveAgentProvider('kimi', '', { ...input, protocol: 'graphql' })
    expect(protocol.reason).toBe('invalid')
    const url = await saveAgentProvider('kimi', '', { ...input, baseUrl: 'ftp://x' })
    expect(url.reason).toBe('invalid')
    const model = await saveAgentProvider('kimi', '', { ...input, models: [{ id: '' }] })
    expect(model.reason).toBe('invalid')

    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('rejects a slash or whitespace id for opencode, whose references are provider/model', async () => {
    await install('opencode', JSON.stringify({ provider: {} }))
    const outcome = await saveAgentProvider('opencode', '', { ...input, id: 'a/b' })
    expect(outcome.reason).toBe('invalid')
  })

  it('reports not-installed when the agent has no config file', async () => {
    const outcome = await saveAgentProvider('opencode', '', input)
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toBe('missing')
    expect(outcome.message).toBe('not-installed')
  })

  it('derives the mcode provider key from the display name at creation', async () => {
    await install('mcode', `defaultModel: custom_provider:seed/m\nprovider:\n  seed:\n    api: openai-completions\n`)
    const outcome = await saveAgentProvider('mcode', '', {
      id: 'my-relay',
      name: 'My Relay',
      protocol: 'openai-responses',
      apiKey: 'sk-derived-1',
      models: [],
    })
    expect(outcome.ok).toBe(true)
    const text = await readFile(join(state.home, '.minimax', 'config.yaml'), 'utf8')
    expect(text).toContain('custom_provider:')
    expect(text).toContain('my-relay')
    // The built-in tree is carried through untouched.
    expect(text).toContain('seed')
  })
})

describe('removeAgentProvider', () => {
  it('deletes the provider through the chain and keeps the rest of the file', async () => {
    const path = await install('kimi', KIMI_TOML)
    const payload = await readAgentConfig('kimi')
    const outcome = await removeAgentProvider('kimi', payload.revision, 'acme')
    expect(outcome.ok).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('[providers.acme]')
    expect(text).toContain('[providers.other]')
    expect(text).toContain('[experimental]')
    expect(text).toContain('default_permission_mode')
  })

  it('honours the revision like save does', async () => {
    await install('kimi', KIMI_TOML)
    const stale = '0'.repeat(64)
    const outcome = await removeAgentProvider('kimi', stale, 'acme')
    expect(outcome.reason).toBe('conflict')
  })
})

describe('revealAgentKey', () => {
  it('returns the plaintext only for the requested provider', async () => {
    await install('kimi', KIMI_TOML)
    const reveal = await revealAgentKey('kimi', 'acme')
    expect(reveal.ok).toBe(true)
    expect(reveal.key).toBe('sk-acme-0001112222')
    const missing = await revealAgentKey('kimi', 'ghost')
    expect(missing).toEqual({ ok: false, message: 'no-key' })
  })

  it('reports not-installed without a config file', async () => {
    expect(await revealAgentKey('kimi', 'acme')).toEqual({ ok: false, message: 'not-installed' })
  })
})

describe('backup layout', () => {
  it('names the backup after the config file with the feature prefix', async () => {
    const path = await install('kimi', KIMI_TOML)
    const outcome = await saveAgentProvider('kimi', '', {
      id: 'another',
      name: 'another',
      protocol: 'openai',
      models: [],
    })
    expect(outcome.ok).toBe(true)
    const backupPath = outcome.ok ? outcome.backupPath : ''
    expect(backupPath!.startsWith(`${path}.bak-agentconfig-`)).toBe(true)
    await stat(backupPath!)
  })
})
