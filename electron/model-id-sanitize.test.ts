import { mkdir, mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { decodeNonAsciiIds, encodeNonAsciiIds, ensureScannableModelIds } from './model-id-sanitize'

/**
 * model-id-sanitize is the only module in the repo that rewrites another
 * application's files (agent session transcripts), so the safety rails are
 * part of the contract: a line that fails to parse skips the whole file, the
 * structural key pattern never touches escaped look-alikes inside tool output,
 * percent-encode → decode round-trips, and every rewrite is preceded by a
 * recoverable copy with a bounded retention policy.
 */

const dirs: string[] = []

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

/** Backdate a file so the live-file guard (90s) does not skip it */
async function backdate(path: string, ms = 120_000): Promise<void> {
  const old = new Date(Date.now() - ms)
  await utimes(path, old, old)
}

/** Backup listing that treats a never-created backup directory as empty */
async function listBackups(backupDir: string): Promise<string[]> {
  try {
    return await readdir(backupDir)
  } catch {
    return []
  }
}

describe('encodeNonAsciiIds', () => {
  it('percent-encodes only the id values and preserves the rest byte-for-byte', () => {
    const line = `{"ts":123,"model":"zhipuai-coding-plan/新模型","msg":"你好 世界","float":1.50,"nested":{"a":[1,2]}}\n`
    const { text, changed } = encodeNonAsciiIds(line)
    expect(changed).toBe(true)
    // Id value encoded to pure ASCII
    expect(text).toContain('"model":"zhipuai-coding-plan/%E6%96%B0%E6%A8%A1%E5%9E%8B"')
    // Everything else survives untouched: message text, float formatting, key order
    expect(text).toContain('"msg":"你好 世界"')
    expect(text).toContain('"float":1.50')
    expect(text).toContain('"nested":{"a":[1,2]}')
    expect(text.endsWith('\n')).toBe(true)
    expect(text.startsWith('{"ts":123,"model":')).toBe(true)
  })

  it('rewrites every id-bearing key', () => {
    const line = `{"model":"模型","modelAlias":"别名","modelId":"代号","provider":"提供者","providerId":"供应商"}`
    const { text, changed } = encodeNonAsciiIds(line)
    expect(changed).toBe(true)
    const parsed = JSON.parse(text) as Record<string, string>
    for (const key of ['model', 'modelAlias', 'modelId', 'provider', 'providerId']) {
      expect(parsed[key]).not.toMatch(/[^\u0000-\u007f]/)
    }
    // Decoding one of them gives the original back
    expect(decodeNonAsciiIds({ contributions: [{ clients: [{ modelAlias: parsed.modelAlias }] }] })).toEqual({
      contributions: [{ clients: [{ modelAlias: '别名' }] }],
    })
  })

  it('leaves escaped id keys inside tool-output strings alone', () => {
    const line = JSON.stringify({
      model: 'zhipu/新模型',
      messages: [{ role: 'tool', content: `output: {"model": "内部新模型", "providerId": "内部供应商"}` }],
    })
    const { text, changed } = encodeNonAsciiIds(line)
    // The structural model id is rewritten…
    expect(changed).toBe(true)
    expect(text).toContain('"model":"zhipu/%E6%96%B0%E6%A8%A1%E5%9E%8B"')
    // …but the escaped look-alikes inside the tool-output string are not
    expect(text).toContain('{\\"model\\": \\"内部新模型\\", \\"providerId\\": \\"内部供应商\\"}')
  })

  it('decodes \\uXXXX escapes before checking for non-ASCII', () => {
    const line = `{"modelAlias":"\\u65b0\\u6a21\\u578b"}`
    const { text, changed } = encodeNonAsciiIds(line)
    expect(changed).toBe(true)
    // The literal text has no non-ASCII bytes, but tokscale would see 新模型
    expect(text).toBe(`{"modelAlias":"%E6%96%B0%E6%A8%A1%E5%9E%8B"}`)
  })

  it('encodes astral characters (surrogate pairs) byte by byte', () => {
    const line = JSON.stringify({ modelId: 'kimi/🚀新' })
    const { text, changed } = encodeNonAsciiIds(line)
    expect(changed).toBe(true)
    expect(text).toContain('"modelId":"kimi/%F0%9F%9A%80%E6%96%B0"')
  })

  it('leaves an all-ASCII file untouched', () => {
    const text = `{"model":"gpt-5.2"}\n{"modelAlias":"claude-opus-4.6"}\n`
    expect(encodeNonAsciiIds(text)).toEqual({ text, changed: false })
  })

  it('skips the whole file when any line fails to parse', () => {
    const text = `{"model":"新模型"}\nnot json at all\n{"providerId":"供应商"}\n`
    expect(encodeNonAsciiIds(text)).toEqual({ text, changed: false })
  })

  it('passes through an id value that is already pure ASCII', () => {
    const text = `{"model":"zhipu/ascii-only"}`
    expect(encodeNonAsciiIds(text)).toEqual({ text, changed: false })
  })
})

describe('encode → decode round trip', () => {
  const VALUES = [
    'zhipuai-coding-plan/新模型',
    '智谱清言',
    'kimi/🚀新',
    '한국어모델',
    'café-model',
    'ミックス中文',
  ]

  for (const value of VALUES) {
    it(`round-trips ${JSON.stringify(value)}`, () => {
      const line = JSON.stringify({ model: value }) + '\n'
      const { text } = encodeNonAsciiIds(line)
      const encoded = (JSON.parse(text) as { model: string }).model
      const out = decodeNonAsciiIds({
        contributions: [{ clients: [{ client: 'zcode', modelId: encoded }] }],
      }) as { contributions: Array<{ clients: Array<{ modelId: string }> }> }
      expect(out.contributions[0]?.clients[0]?.modelId).toBe(value)
    })
  }

  it('leaves an ASCII value alone in both directions', () => {
    const ascii = 'opencode/deepseek-v4-flash-free'
    expect(encodeNonAsciiIds(JSON.stringify({ model: ascii }))).toEqual({
      text: JSON.stringify({ model: ascii }),
      changed: false,
    })
  })

  it('decodes only high-byte %XX runs: ASCII percent escapes survive', () => {
    const out = decodeNonAsciiIds({
      contributions: [{ clients: [{ modelId: '100%20big%41cat' }] }],
    }) as { contributions: Array<{ clients: Array<{ modelId: string }> }> }
    // %20 and %41 carry low bytes, which the encoder never emits — untouched
    expect(out.contributions[0]?.clients[0]?.modelId).toBe('100%20big%41cat')
  })

  it('decodes a mixed run and keeps the trailing low-byte escape', () => {
    const out = decodeNonAsciiIds({
      contributions: [{ clients: [{ modelId: '%E6%96%B0%20ok' }] }],
    }) as { contributions: Array<{ clients: Array<{ modelId: string }> }> }
    expect(out.contributions[0]?.clients[0]?.modelId).toBe('新%20ok')
  })

  it('passes through payloads without contributions or without percent signs', () => {
    const bare = { contributions: [{ clients: [{ modelId: 'no-percent-here' }] }] }
    expect(decodeNonAsciiIds(bare)).toEqual(bare)
    expect(decodeNonAsciiIds(null)).toBeNull()
    expect(decodeNonAsciiIds('string')).toBe('string')
    expect(decodeNonAsciiIds({ contributions: 'not-an-array' })).toEqual({ contributions: 'not-an-array' })
  })
})

describe('ensureScannableModelIds', () => {
  const ORIGINAL = `{"model":"zhipuai-coding-plan/新模型","msg":"你好"}\n{"modelAlias":"别名"}\n`
  const ENCODED_MODEL = 'zhipuai-coding-plan/%E6%96%B0%E6%A8%A1%E5%9E%8B'

  async function writeSession(root: string, name: string, content: string): Promise<string> {
    const file = join(root, 'proj-a', name)
    await mkdir(join(root, 'proj-a'), { recursive: true })
    await writeFile(file, content)
    await backdate(file)
    return file
  }

  it('backs up the original before rewriting, then records the file as verified', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const file = await writeSession(root, 'session.jsonl', ORIGINAL)
    const stateFile = join(stateDir, 'model-id-sanitize.json')

    await ensureScannableModelIds([root], stateFile)

    // The transcript is rewritten in place
    const rewritten = await readFile(file, 'utf8')
    expect(rewritten).toContain(`"model":"${ENCODED_MODEL}"`)
    expect(rewritten).toContain('"msg":"你好"')
    expect(rewritten).toContain('"modelAlias":"%E5%88%AB%E5%90%8D"')

    // A recoverable copy of the original exists next to the state file
    const backupDir = join(stateDir, 'model-id-backups')
    const backups = await readdir(backupDir)
    expect(backups).toHaveLength(1)
    expect(backups[0]).toMatch(/^\d{13}-0-session\.jsonl$/)
    expect(await readFile(join(backupDir, backups[0] ?? ''), 'utf8')).toBe(ORIGINAL)

    // The state file remembers the rewritten file so it is not re-read
    const state = JSON.parse(await readFile(stateFile, 'utf8')) as Record<string, { size: number; mtimeMs: number }>
    const after = await stat(file)
    expect(state[file]).toEqual({ size: after.size, mtimeMs: after.mtimeMs })
  })

  it('does not rewrite or re-back-up a file already recorded in the state', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const file = await writeSession(root, 'session.jsonl', ORIGINAL)
    const stateFile = join(stateDir, 'model-id-sanitize.json')
    await ensureScannableModelIds([root], stateFile)
    const rewritten = await readFile(file, 'utf8')
    const backupCount = (await readdir(join(stateDir, 'model-id-backups'))).length

    await ensureScannableModelIds([root], stateFile)

    expect(await readFile(file, 'utf8')).toBe(rewritten)
    expect((await readdir(join(stateDir, 'model-id-backups'))).length).toBe(backupCount)
  })

  it('skips a file the running agent is still appending to (live-file guard)', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const file = join(root, 'proj-a', 'live.jsonl')
    await mkdir(join(root, 'proj-a'), { recursive: true })
    await writeFile(file, ORIGINAL) // fresh mtime = now, inside the 90s window

    await ensureScannableModelIds([root], join(stateDir, 'model-id-sanitize.json'))

    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
    expect(await listBackups(join(stateDir, 'model-id-backups'))).toEqual([])
  })

  it('leaves a file with an unparsable line untouched, entirely', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const file = await writeSession(root, 'corrupt.jsonl', `{"model":"新模型"}\ncorrupt tail\n`)
    const stateFile = join(stateDir, 'model-id-sanitize.json')

    await ensureScannableModelIds([root], stateFile)

    expect(await readFile(file, 'utf8')).toBe(`{"model":"新模型"}\ncorrupt tail\n`)
    // No backup was made for a file that was never rewritten
    expect(await listBackups(join(stateDir, 'model-id-backups'))).toEqual([])
  })

  it('skips the rewrite when the backup cannot be made (fail closed)', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const file = await writeSession(root, 'session.jsonl', ORIGINAL)
    // Occupy the backup directory path with a regular file so the copy fails
    await writeFile(join(stateDir, 'model-id-backups'), 'not a directory')

    await ensureScannableModelIds([root], join(stateDir, 'model-id-sanitize.json'))

    expect(await readFile(file, 'utf8')).toBe(ORIGINAL)
  })

  it('prunes backups beyond the retention count, oldest first', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const backupDir = join(stateDir, 'model-id-backups')
    await mkdir(backupDir, { recursive: true })
    // 22 recent backups (all inside the age window, above the 20-file cap)
    const stamps = Array.from({ length: 22 }, (_, i) => Date.now() - (i + 1) * 60_000)
    for (const [i, stamp] of stamps.entries()) {
      await writeFile(join(backupDir, `${stamp}-0-old-${i}.jsonl`), 'old')
    }
    // A transcript that needs a rewrite so this sweep performs a fresh backup
    await writeSession(root, 'session.jsonl', ORIGINAL)

    await ensureScannableModelIds([root], join(stateDir, 'model-id-sanitize.json'))

    const remaining = await readdir(backupDir)
    expect(remaining).toHaveLength(20)
    // The fresh backup survives and the three oldest pre-existing ones are gone
    expect(remaining.some((name) => name.endsWith('session.jsonl'))).toBe(true)
    expect(remaining.some((name) => name.endsWith(`old-${21}.jsonl`))).toBe(false)
    expect(remaining.some((name) => name.endsWith(`old-${20}.jsonl`))).toBe(false)
    expect(remaining.some((name) => name.endsWith(`old-${19}.jsonl`))).toBe(false)
    expect(remaining.some((name) => name.endsWith(`old-0.jsonl`))).toBe(true)
  })

  it('prunes backups older than the retention window regardless of count', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const backupDir = join(stateDir, 'model-id-backups')
    await mkdir(backupDir, { recursive: true })
    // Five ancient copies (stamp epoch 2001) must age out even though the
    // directory is far below the count cap
    for (let i = 0; i < 5; i += 1) {
      await writeFile(join(backupDir, `1000000000000-0-ancient-${i}.jsonl`), 'ancient')
    }
    await writeSession(root, 'session.jsonl', ORIGINAL)

    await ensureScannableModelIds([root], join(stateDir, 'model-id-sanitize.json'))

    const remaining = await readdir(backupDir)
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatch(/^\d{13}-0-session\.jsonl$/)
  })

  it('tolerates a missing root and a corrupt state file', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    const stateFile = join(stateDir, 'model-id-sanitize.json')
    await writeFile(stateFile, 'corrupt-state{{{')
    const file = await writeSession(root, 'session.jsonl', ORIGINAL)

    // A missing root must not throw, and the corrupt state starts fresh
    await expect(ensureScannableModelIds([join(root, 'missing'), root], stateFile)).resolves.toBeUndefined()
    expect(await readFile(file, 'utf8')).toContain(`"model":"${ENCODED_MODEL}"`)
  })

  it('ignores non-jsonl files and files that are empty', async () => {
    const root = await tempDir('sanitize-root-')
    const stateDir = await tempDir('sanitize-state-')
    await mkdir(join(root, 'proj-a'), { recursive: true })
    const json = join(root, 'proj-a', 'notes.json')
    await writeFile(json, '{"model":"新模型"}')
    const empty = join(root, 'proj-a', 'empty.jsonl')
    await writeFile(empty, '')

    await expect(ensureScannableModelIds([root], join(stateDir, 'model-id-sanitize.json'))).resolves.toBeUndefined()

    // Neither file is touched, and with nothing verified the state file is not written at all
    expect(await readFile(json, 'utf8')).toBe('{"model":"新模型"}')
    await expect(readFile(join(stateDir, 'model-id-sanitize.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
