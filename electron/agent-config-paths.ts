import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Locating the two coding agents' configuration files.
 *
 * Both agents allow their data directory to be relocated by an environment
 * variable, and mcode is in the middle of *changing its default*: the installed
 * 0.4.12 build still reads `~/.minimax`, while the source tree already returns
 * `~/.minimax-code` from `packages/tui/src/runtime/data-dir.ts`. Hardcoding
 * either path would break on the next upgrade, so every candidate is probed and
 * "a config file exists there" is the final judge.
 *
 * `~/.minimax-code` is a trap worth naming: today it is the npm *install*
 * prefix (releases/, current pointer, bundled node) and holds no config file —
 * but it is also the value the source tree will start using as the data
 * directory. Probing both, and preferring whichever actually has a config file,
 * covers both generations.
 */

export type AgentId = 'kimi' | 'mcode'

export interface AgentLocation {
  id: AgentId
  /** Config file actually in use; null when the agent is not configured */
  configPath: string | null
  /** Directory holding the config file; null when not found */
  dataDir: string | null
  /** Data directories probed, in order — surfaced so the UI can explain a miss */
  candidates: string[]
  /** CLI entry points that exist on disk, in probe order */
  cliPaths: string[]
}

/** Pick the first path that exists as a regular file */
function firstFile(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (statSync(p).isFile()) return p
    } catch {
      // missing path is the normal case for most candidates
    }
  }
  return null
}

/** Non-empty trimmed environment value, or undefined */
function env(name: string): string | undefined {
  const v = process.env[name]?.trim()
  return v ? v : undefined
}

/**
 * Every directory kimicode might use for its data, most specific first.
 * `KIMI_CODE_HOME` is documented, and the CLI's own `--home` flag sits above it
 * for command-line runs (irrelevant here — we read the file, not the flag).
 */
function kimiDataDirs(): string[] {
  const home = homedir()
  const out: string[] = []
  const explicit = env('KIMI_CODE_HOME')
  if (explicit) out.push(explicit)
  out.push(join(home, '.kimi-code'))
  return out
}

/**
 * Every directory mcode might use, most specific first.
 *
 * Order matters: `MINIMAX_DATA_DIR` (and its legacy twin `MAVIS_DATA_DIR`) win
 * over both defaults, and the legacy `~/.minimax` is probed before
 * `~/.minimax-code` because that is where the *installed* build keeps its file
 * today.
 */
function mcodeDataDirs(): string[] {
  const home = homedir()
  const out: string[] = []
  const explicit = env('MINIMAX_DATA_DIR') ?? env('MAVIS_DATA_DIR')
  if (explicit) out.push(explicit)
  out.push(join(home, '.minimax'))
  out.push(join(home, '.minimax-code'))
  out.push(join(home, '.mavis'))
  return out
}

/**
 * CLI entry candidates for mcode.
 *
 * `~/.minimax/bin/{minimax,mavis}.cmd` are deliberately excluded: on a real
 * install they are stale wrappers pointing at a desktop app path that no longer
 * exists, so probing them would report a CLI that cannot run.
 */
function mcodeCliPaths(): string[] {
  const home = homedir()
  const dir = join(home, '.minimax-code')
  return process.platform === 'win32'
    ? [join(dir, 'mcode.cmd'), join(dir, 'mcode.ps1'), join(dir, 'mcode')]
    : [join(dir, 'mcode'), join(dir, 'mcode.sh')]
}

function kimiCliPaths(): string[] {
  const home = homedir()
  const out: string[] = []
  const explicit = env('KIMI_CODE_HOME')
  const dirs = explicit ? [explicit, join(home, '.kimi-code')] : [join(home, '.kimi-code')]
  for (const dir of dirs) {
    out.push(
      process.platform === 'win32' ? join(dir, 'bin', 'kimi.exe') : join(dir, 'bin', 'kimi'),
    )
  }
  return out
}

/** Resolve one agent's config location and CLI entry points */
export function resolveAgentLocation(id: AgentId): AgentLocation {
  if (id === 'kimi') {
    const candidates = kimiDataDirs()
    const configPath = firstFile(candidates.map((d) => join(d, 'config.toml')))
    return {
      id,
      configPath,
      dataDir: configPath ? dirnameOf(configPath) : null,
      candidates,
      cliPaths: kimiCliPaths().filter(existsSync),
    }
  }
  const candidates = mcodeDataDirs()
  const configPath = firstFile(candidates.map((d) => join(d, 'config.yaml')))
  return {
    id,
    configPath,
    dataDir: configPath ? dirnameOf(configPath) : null,
    candidates,
    cliPaths: mcodeCliPaths().filter(existsSync),
  }
}

/** Parent directory of a file path (kept local to avoid importing node:path twice) */
function dirnameOf(filePath: string): string {
  const idx = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'))
  return idx > 0 ? filePath.slice(0, idx) : filePath
}

/** Both agents' locations keyed by id */
export function resolveAllAgentLocations(): Record<AgentId, AgentLocation> {
  return { kimi: resolveAgentLocation('kimi'), mcode: resolveAgentLocation('mcode') }
}
