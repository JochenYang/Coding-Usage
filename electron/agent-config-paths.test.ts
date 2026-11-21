import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveAgentLocation } from './agent-config-paths'

/**
 * The three agents relocate their data directories through environment
 * variables and mcode is mid-migration between defaults, so "a config file
 * exists there" — not a hardcoded path — is what decides the location. The
 * probe runs against a fake home directory (mocked `homedir`) plus temporary
 * directories named by the documented variables, pinning precedence and the
 * `opencode.json`-over-`opencode.jsonc` preference.
 */

const state = vi.hoisted(() => ({ home: '' }))

vi.mock('node:os', async (importOriginal) => {
  const os = await importOriginal<typeof import('node:os')>()
  return { ...os, homedir: () => state.home }
})

const ENV_NAMES = ['KIMI_CODE_HOME', 'MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR', 'OPENCODE_CONFIG_DIR'] as const

const dirs: string[] = []
const savedEnv: Record<string, string | undefined> = {}
let savedPath: string | undefined

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

async function put(path: string, content = 'x'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, 'utf8')
}

beforeEach(async () => {
  state.home = await tempDir('agent-config-paths-home-')
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
  savedPath = process.env.PATH
})

afterEach(async () => {
  for (const name of ENV_NAMES) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  process.env.PATH = savedPath
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('kimi location', () => {
  it('prefers KIMI_CODE_HOME over the default directory and reports both candidates', async () => {
    const explicit = await tempDir('kimi-home-')
    process.env.KIMI_CODE_HOME = explicit
    const configPath = join(explicit, 'config.toml')
    await put(configPath)

    const location = resolveAgentLocation('kimi')
    expect(location.configPath).toBe(configPath)
    expect(location.dataDir).toBe(explicit)
    expect(location.candidates).toEqual([explicit, join(state.home, '.kimi-code')])
    expect(location.cliPaths).toEqual([])
  })

  it('falls back to ~/.kimi-code when the variable is unset', async () => {
    const configPath = join(state.home, '.kimi-code', 'config.toml')
    await put(configPath)

    const location = resolveAgentLocation('kimi')
    expect(location.configPath).toBe(configPath)
    expect(location.candidates).toEqual([join(state.home, '.kimi-code')])
  })

  it('detects a CLI binary under the data directory', async () => {
    const explicit = await tempDir('kimi-cli-')
    process.env.KIMI_CODE_HOME = explicit
    const binary = process.platform === 'win32' ? 'kimi.exe' : 'kimi'
    await put(join(explicit, 'bin', binary))

    const location = resolveAgentLocation('kimi')
    expect(location.cliPaths).toEqual([join(explicit, 'bin', binary)])
  })

  it('reports not configured when no candidate holds a config file', () => {
    const location = resolveAgentLocation('kimi')
    expect(location.configPath).toBeNull()
    expect(location.dataDir).toBeNull()
    expect(location.cliPaths).toEqual([])
  })
})

describe('mcode location', () => {
  it('puts MINIMAX_DATA_DIR first in the candidates', async () => {
    const explicit = await tempDir('minimax-env-')
    process.env.MINIMAX_DATA_DIR = explicit
    const location = resolveAgentLocation('mcode')
    expect(location.candidates).toEqual([
      explicit,
      join(state.home, '.minimax'),
      join(state.home, '.minimax-code'),
      join(state.home, '.mavis'),
    ])
  })

  it('falls back to MAVIS_DATA_DIR when MINIMAX_DATA_DIR is unset', async () => {
    const mavis = await tempDir('mavis-env-')
    process.env.MAVIS_DATA_DIR = mavis
    const location = resolveAgentLocation('mcode')
    expect(location.candidates[0]).toBe(mavis)
  })

  it('prefers the legacy ~/.minimax over ~/.minimax-code when both hold a config', async () => {
    // The installed build (0.4.12) still reads ~/.minimax; the source tree is
    // moving to ~/.minimax-code. The file that actually exists wins.
    const legacy = join(state.home, '.minimax', 'config.yaml')
    const next = join(state.home, '.minimax-code', 'config.yaml')
    await put(legacy)
    await put(next)

    const location = resolveAgentLocation('mcode')
    expect(location.configPath).toBe(legacy)
    expect(location.dataDir).toBe(join(state.home, '.minimax'))
  })

  it('uses ~/.minimax-code when the legacy directory is empty', async () => {
    const next = join(state.home, '.minimax-code', 'config.yaml')
    await put(next)
    const location = resolveAgentLocation('mcode')
    expect(location.configPath).toBe(next)
  })

  it('detects the mcode CLI under ~/.minimax-code only', async () => {
    // `.minimax/bin/{minimax,mavis}.cmd` are deliberately excluded: real
    // installs carry stale wrappers pointing at a removed desktop app.
    const excluded = process.platform === 'win32' ? join(state.home, '.minimax', 'bin', 'minimax.cmd') : null
    if (excluded) await put(excluded)
    const binary = process.platform === 'win32' ? 'mcode.cmd' : 'mcode'
    await put(join(state.home, '.minimax-code', binary))

    const location = resolveAgentLocation('mcode')
    expect(location.cliPaths).toEqual([join(state.home, '.minimax-code', binary)])
  })
})

describe('opencode location', () => {
  it('prefers OPENCODE_CONFIG_DIR and finds opencode.json there', async () => {
    const explicit = await tempDir('opencode-env-')
    process.env.OPENCODE_CONFIG_DIR = explicit
    const configPath = join(explicit, 'opencode.json')
    await put(configPath)

    const location = resolveAgentLocation('opencode')
    expect(location.configPath).toBe(configPath)
    expect(location.candidates).toEqual([explicit, join(state.home, '.config', 'opencode')])
  })

  it('accepts opencode.jsonc only when the plain spelling is absent', async () => {
    const dir = join(state.home, '.config', 'opencode')
    const both = resolveAgentLocation('opencode') // nothing on disk yet
    expect(both.configPath).toBeNull()

    await put(join(dir, 'opencode.jsonc'))
    expect(resolveAgentLocation('opencode').configPath).toBe(join(dir, 'opencode.jsonc'))

    await put(join(dir, 'opencode.json'))
    expect(resolveAgentLocation('opencode').configPath).toBe(join(dir, 'opencode.json'))
  })

  it('finds the CLI on PATH', async () => {
    const bin = await tempDir('opencode-bin-')
    const name = process.platform === 'win32' ? 'opencode.cmd' : 'opencode'
    await put(join(bin, name))
    const separator = process.platform === 'win32' ? ';' : ':'
    process.env.PATH = bin + separator + (process.env.PATH ?? '')

    const location = resolveAgentLocation('opencode')
    expect(location.cliPaths).toContain(join(bin, name))
  })
})
