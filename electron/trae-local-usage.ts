import { spawn } from 'node:child_process'
import { createDecipheriv, createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Trae CN / TRAE SOLO CN local usage reader (SQLCipher 4 store).
 *
 * tokscale's `trae` client only serves the international build (cloud account
 * sync); the CN builds keep every AI-agent session in a SQLCipher 4 encrypted
 * SQLite store at `<appData>/<Product>/ModularData/ai-agent/database.db`, and
 * the 256-bit key exists only inside the running IDE's process memory.
 *
 * Pipeline (verified against Trae CN 2.3.x / SOLO CN 2.3.x):
 *   1. A small C# helper (source embedded below, compiled once into userData
 *      with the framework's own csc.exe) scans the running IDE's committed
 *      memory regions for hex key candidates and verifies each against the
 *      database's page-1 HMAC (PBKDF2-HMAC-SHA512, 2 iterations, salt^0x3A —
 *      the standard SQLCipher 4 scheme, same as the public trae-db-decrypt
 *      reference). Only a verified key is ever printed back.
 *   2. This module snapshots the encrypted db, decrypts it page-by-page
 *      (AES-256-CBC, per-page IV from the 80-byte reserve area) with
 *      node:crypto, and reads `chat_turn.context` JSON from the decrypted
 *      copy. Turns carry `token_usage` (prompt/completion/cache counters)
 *      and the model's `config_name`.
 *   3. Per-day slices are emitted as a `tokscale graph`-shaped payload with
 *      client `trae`, which the main process merges into the scan. tokscale's
 *      own trae data (international cloud sync) can never overlap this local
 *      CN store, so the merge is unconditional (see main.ts mergeAlways).
 *
 * Limits, all degrading to "no trae data" rather than wrong numbers:
 *   - The IDE must be running (the key is nowhere else). To keep the row
 *     stable across IDE/app restarts, the last aggregated payload (token
 *     counters only, never content) is cached in userData and replayed when
 *     a fresh scan is impossible.
 *   - Pages still inside the encrypted WAL are not read, so the freshest
 *     minutes appear only after the IDE's next checkpoint.
 *   - SOLO builds may switch encryption schemes between versions; a key that
 *     fails HMAC verification simply skips that product.
 *
 * Privacy / secrets: the key lives only in this process's memory (never
 * written to disk, never logged); the decrypted database copy is deleted
 * immediately after aggregation; only token counters and model ids cross
 * this module — chat content is never read into application data.
 */

/** Client id this module feeds; must exist in AGENT_CLIENTS (src/lib/agent-usage.ts) */
const CLIENT_ID = 'trae'

/** Provider every Trae generation is attributed to */
const PROVIDER_ID = 'trae'

/** Product app-data dir name → running process base name (without .exe) */
const PRODUCTS: ReadonlyArray<{ dir: string; exe: string }> = [
  { dir: 'Trae CN', exe: 'Trae CN' },
  { dir: 'TRAE SOLO CN', exe: 'TRAE SOLO CN' },
]

const DB_REL = join('ModularData', 'ai-agent', 'database.db')

// SQLCipher 4 geometry (page_size 4096, reserve 80, HMAC-SHA512)
const PAGE_SZ = 4096
const SALT_SZ = 16
const RESERVE_SZ = 80
const IV_SZ = 16
const SQLITE_HDR = Buffer.from('SQLite format 3\0', 'latin1')

const KEYSCAN_TIMEOUT_MS = 90_000
const COMPILE_TIMEOUT_MS = 60_000

interface UsageRecord {
  tsMs: number
  modelId: string
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

interface Slice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  messages: number
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** Local calendar day, matching the renderer's `todayKey()` bucketing */
function localDay(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number): string => `${n}`.padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ===== keyscan helper (compiled once into userData) =====

/**
 * C# source of the memory scanner. Mirrors the public trae-db-decrypt /
 * wechat-decrypt approach: enumerate the IDE's committed readable regions,
 * pull hex key candidates out of the bytes and accept the first one whose
 * derived MAC key reproduces page 1's stored HMAC-SHA512. Args:
 * `<process base name> <database.db path>`; prints `{"encKey":"<hex>"}` or
 * `{"error":"..."}` on a single stdout line. The key never touches disk.
 */
const KEYSCAN_CS = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

internal static class TraeKeyscan {
  private const int MEM_COMMIT = 0x1000;
  private const int PAGE_SZ = 4096, SALT_SZ = 16, RESERVE_SZ = 80, IV_SZ = 16, HMAC_SZ = 64;
  private static readonly HashSet<uint> Readable = new HashSet<uint> { 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80 };

  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")]
  private static extern int VirtualQueryEx(IntPtr h, IntPtr addr, out MemInfo info, int size);
  [DllImport("kernel32.dll")]
  private static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, int size, out int read);

  [StructLayout(LayoutKind.Sequential)]
  private struct MemInfo {
    public long BaseAddress;
    public long AllocationBase;
    public uint AllocationProtect;
    public uint Pad1;
    public long RegionSize;
    public uint State;
    public uint Protect;
    public uint Type;
    public uint Pad2;
  }

  private static bool IsHex(byte b) {
    return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'f') || (b >= 'A' && b <= 'F');
  }

  private static byte[] HexToBytes(string h) {
    var bytes = new byte[h.Length / 2];
    for (var i = 0; i < bytes.Length; i++) bytes[i] = Convert.ToByte(h.Substring(i * 2, 2), 16);
    return bytes;
  }

  // SQLCipher 4: mac_key = PBKDF2-HMAC-SHA512(key, salt ^ 0x3A, 2)[:32]. Two
  // iterations and one block, so a bare HMAC chain is enough.
  private static byte[] DeriveMacKey(byte[] encKey, byte[] salt) {
    var macSalt = (byte[])salt.Clone();
    for (var i = 0; i < macSalt.Length; i++) macSalt[i] ^= 0x3A;
    using (var h = new HMACSHA512(encKey)) {
      var block = new byte[macSalt.Length + 4];
      Buffer.BlockCopy(macSalt, 0, block, 0, macSalt.Length);
      block[block.Length - 1] = 1;
      var u1 = h.ComputeHash(block);
      var u2 = h.ComputeHash(u1);
      var mac = new byte[32];
      for (var i = 0; i < 32; i++) mac[i] = (byte)(u1[i] ^ u2[i]);
      return mac;
    }
  }

  private static bool VerifyKey(byte[] encKey, byte[] page1) {
    try {
      var salt = new byte[SALT_SZ];
      Buffer.BlockCopy(page1, 0, salt, 0, SALT_SZ);
      var macKey = DeriveMacKey(encKey, salt);
      var data = new byte[PAGE_SZ - RESERVE_SZ + IV_SZ - SALT_SZ + 4];
      Buffer.BlockCopy(page1, SALT_SZ, data, 0, data.Length - 4);
      data[data.Length - 4] = 1; // page number 1, little-endian
      using (var h = new HMACSHA512(macKey)) {
        var hm = h.ComputeHash(data);
        for (var i = 0; i < HMAC_SZ; i++) if (hm[i] != page1[PAGE_SZ - HMAC_SZ + i]) return false;
        return true;
      }
    } catch {
      return false;
    }
  }

  private static string ScanRegion(byte[] data, byte[] page1, string saltHex) {
    var i = 0;
    while (i < data.Length) {
      if (!IsHex(data[i])) { i++; continue; }
      var start = i;
      while (i < data.Length && IsHex(data[i])) i++;
      var len = i - start;
      string keyHex = null;
      if (len == 96) {
        if (Encoding.ASCII.GetString(data, start + 64, 32).Equals(saltHex, StringComparison.OrdinalIgnoreCase))
          keyHex = Encoding.ASCII.GetString(data, start, 64);
      } else if (len == 64) {
        keyHex = Encoding.ASCII.GetString(data, start, 64);
      } else if (len > 96 && len % 2 == 0) {
        if (Encoding.ASCII.GetString(data, i - 32, 32).Equals(saltHex, StringComparison.OrdinalIgnoreCase))
          keyHex = Encoding.ASCII.GetString(data, start, 64);
      }
      if (keyHex != null && VerifyKey(HexToBytes(keyHex), page1)) return keyHex;
    }
    return null;
  }

  public static int Main(string[] args) {
    if (args.Length < 2) { Console.WriteLine("{\"error\":\"usage\"}"); return 2; }
    var exeName = args[0];
    var dbPath = args[1];
    byte[] page1;
    try {
      using (var fs = new FileStream(dbPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        page1 = new byte[PAGE_SZ];
        if (fs.Read(page1, 0, PAGE_SZ) < PAGE_SZ) { Console.WriteLine("{\"error\":\"db-too-small\"}"); return 2; }
      }
    } catch {
      Console.WriteLine("{\"error\":\"db-read\"}");
      return 2;
    }
    var saltHex = BitConverter.ToString(page1, 0, SALT_SZ).Replace("-", "").ToLowerInvariant();

    Process[] procs;
    try {
      procs = Process.GetProcessesByName(exeName).OrderByDescending(p => p.WorkingSet64).ToArray();
    } catch {
      Console.WriteLine("{\"error\":\"enum\"}");
      return 2;
    }
    // Preferred pids (the ai_agent module host) come first: the key lives in
    // that process, so a full sweep of every renderer is usually wasted time.
    var preferred = new HashSet<int>();
    for (var i = 2; i < args.Length; i++) { int v; if (int.TryParse(args[i], out v)) preferred.Add(v); }
    var ordered = procs.Where(p => preferred.Contains(p.Id)).Concat(procs.Where(p => !preferred.Contains(p.Id)));
    foreach (var proc in ordered) {
      IntPtr h = IntPtr.Zero;
      try {
        h = OpenProcess(0x0010 | 0x0400, false, proc.Id); // VM_READ | QUERY_INFORMATION
        if (h == IntPtr.Zero) continue;
        long addr = 0;
        var info = new MemInfo();
        while (addr < 0x7FFFFFFFFFFF) {
          if (VirtualQueryEx(h, new IntPtr(addr), out info, Marshal.SizeOf(info)) == 0) break;
          if (info.State == MEM_COMMIT && Readable.Contains(info.Protect) && info.RegionSize > 0 && info.RegionSize < 500L * 1024 * 1024) {
            var buf = new byte[(int)info.RegionSize];
            int got;
            if (ReadProcessMemory(h, new IntPtr(info.BaseAddress), buf, buf.Length, out got) && got > 0) {
              if (got < buf.Length) Array.Resize(ref buf, got);
              var found = ScanRegion(buf, page1, saltHex);
              if (found != null) { Console.WriteLine("{\"encKey\":\"" + found + "\"}"); return 0; }
            }
          }
          var next = info.BaseAddress + info.RegionSize;
          if (next <= addr) break;
          addr = next;
        }
      } catch {
        // region race or access change — try the next process
      } finally {
        if (h != IntPtr.Zero) CloseHandle(h);
        proc.Dispose();
      }
    }
    Console.WriteLine("{\"error\":\"not-found\"}");
    return 0;
  }
}
`

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(cmd, args, { windowsHide: true })
    } catch {
      resolve({ code: -1, stdout: '' })
      return
    }
    let stdout = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ code: -1, stdout: '' })
    }, timeoutMs)
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 64 * 1024) stdout += d.toString()
    })
    child.on('error', () => {
      clearTimeout(timer)
      resolve({ code: -1, stdout: '' })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout })
    })
  })
}

/** Framework csc.exe ships with Windows; x64 is required to read a 64-bit IDE */
function cscPath(): string {
  return join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe',
  )
}

/**
 * Compile the keyscan helper once per source revision. Returns the exe path,
 * or null when the toolchain is unavailable (feature degrades, app unaffected).
 */
async function ensureKeyscanExe(userData: string): Promise<string | null> {
  const dir = join(userData, 'trae-local')
  const csPath = join(dir, 'trae-keyscan.cs')
  const exePath = join(dir, 'trae-keyscan.exe')
  const metaPath = join(dir, 'trae-keyscan.json')
  const hash = sha256(KEYSCAN_CS)
  try {
    await mkdir(dir, { recursive: true })
    const meta = asRecord(JSON.parse(await readFile(metaPath, 'utf8').catch(() => '{}')))
    if (meta?.hash === hash) return exePath
    await writeFile(csPath, KEYSCAN_CS, 'utf8')
    const { code } = await run(
      cscPath(),
      ['/nologo', '/target:exe', '/platform:x64', `/out:${exePath}`, csPath],
      COMPILE_TIMEOUT_MS,
    )
    if (code !== 0) return null
    await writeFile(metaPath, JSON.stringify({ hash }), 'utf8')
    return exePath
  } catch {
    return null
  }
}

/** Verified 32-byte key for one product's database, or null (not running / scheme changed) */
async function scanProductKey(exePath: string, exeName: string, dbPath: string): Promise<Buffer | null> {
  const preferred = await findAiAgentPids(exeName)
  const { code, stdout } = await run(exePath, [exeName, dbPath, ...preferred.map(String)], KEYSCAN_TIMEOUT_MS)
  if (code !== 0) return null
  // The single stdout line is the only output; never log it (it carries the key)
  const json = asRecord(JSON.parse(stdout.trim().split('\n').pop() || '{}'))
  const hex = typeof json?.encKey === 'string' ? json.encKey : ''
  return /^[0-9a-fA-F]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null
}

/**
 * PIDs of the product's processes that host `ai_agent.dll` — the SQLCipher
 * key lives in that module's address space, so scanning those first turns a
 * worst-case full sweep (~13 processes) into a sub-second lookup. Uses
 * tasklist's module filter; failures simply mean "no preference".
 */
async function findAiAgentPids(exeName: string): Promise<number[]> {
  const list = await run('tasklist', ['/FI', `IMAGENAME eq ${exeName}.exe`, '/FO', 'CSV', '/NH'], 15_000)
  if (list.code !== 0) return []
  const pids: number[] = []
  for (const line of list.stdout.split('\n')) {
    const match = line.match(/^"[^"]*","(\d+)"/)
    if (match) pids.push(Number(match[1]))
  }
  const preferred: number[] = []
  for (const pid of pids) {
    const mods = await run('tasklist', ['/FI', `PID eq ${pid}`, '/M', '/FO', 'CSV', '/NH'], 15_000)
    if (mods.code === 0 && mods.stdout.toLowerCase().includes('ai_agent')) preferred.push(pid)
  }
  return preferred
}

// ===== page-level decrypt =====

function decryptPage(encKey: Buffer, page: Buffer, pgno: number, out: Buffer, outOff: number): void {
  const iv = page.subarray(PAGE_SZ - RESERVE_SZ, PAGE_SZ - RESERVE_SZ + IV_SZ)
  const decipher = createDecipheriv('aes-256-cbc', encKey, iv)
  decipher.setAutoPadding(false)
  if (pgno === 1) {
    const dec = Buffer.concat([decipher.update(page.subarray(SALT_SZ, PAGE_SZ - RESERVE_SZ)), decipher.final()])
    SQLITE_HDR.copy(out, outOff)
    dec.copy(out, outOff + SALT_SZ)
    // reserve area stays zeroed (fresh buffer)
  } else {
    const dec = Buffer.concat([decipher.update(page.subarray(0, PAGE_SZ - RESERVE_SZ)), decipher.final()])
    dec.copy(out, outOff)
  }
}

/**
 * Snapshot the live encrypted db and write a decrypted copy. Pages still in
 * the encrypted WAL are absent — the copy is as fresh as the IDE's last
 * checkpoint, which is acceptable for usage accounting.
 */
async function decryptDatabase(encKey: Buffer, dbPath: string, snapshotPath: string, outPath: string): Promise<boolean> {
  try {
    await copyFile(dbPath, snapshotPath)
    const buf = await readFile(snapshotPath)
    const pages = Math.floor(buf.length / PAGE_SZ)
    if (pages === 0) return false
    const out = Buffer.alloc(pages * PAGE_SZ)
    for (let p = 1; p <= pages; p++) {
      decryptPage(encKey, buf.subarray((p - 1) * PAGE_SZ, p * PAGE_SZ), p, out, (p - 1) * PAGE_SZ)
    }
    await writeFile(outPath, out)
    return true
  } catch {
    return false
  }
}

// ===== usage extraction =====

interface TurnRow {
  turn_id?: unknown
  created_at?: unknown
  token_usage?: unknown
  model_id?: unknown
}

async function readTurns(decryptedPath: string, productKey: string, records: UsageRecord[], seen: Set<string>): Promise<void> {
  // Imported lazily so a runtime without node:sqlite degrades instead of failing
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(decryptedPath, { readOnly: true })
  try {
    // Only the two sub-fields are selected, never the `context` column itself:
    // it also carries `persist_user_message_context`, i.e. the user's message
    // body, and this module's contract is that no message content is ever read
    // into the process. `json_extract` does the selection inside SQLite, so the
    // text never crosses into application memory.
    const rows = db
      .prepare(
        `SELECT turn_id,
                created_at,
                json_extract(context, '$.token_usage') AS token_usage,
                json_extract(context, '$.persist_user_message_context.model_info.config_name') AS model_id
           FROM chat_turn
          WHERE context IS NOT NULL`,
      )
      .all() as TurnRow[]
    for (const row of rows) {
      const turnId = typeof row.turn_id === 'string' ? row.turn_id : ''
      const createdAt = num(row.created_at)
      if (!turnId || createdAt <= 0) continue
      // json_extract returns a JSON string for an object node; a missing path
      // comes back as null, which is simply a turn without usage.
      let usage: Record<string, unknown> | null = null
      if (typeof row.token_usage === 'string') {
        try {
          usage = asRecord(JSON.parse(row.token_usage))
        } catch {
          continue // torn row mid-write
        }
      } else {
        usage = asRecord(row.token_usage)
      }
      if (!usage) continue
      const input = num(usage.prompt_tokens)
      const output = num(usage.completion_tokens)
      const cacheRead = num(usage.cache_read_input_tokens)
      const cacheWrite = num(usage.cache_creation_input_tokens)
      if (input + output + cacheRead + cacheWrite === 0) continue
      const dedupe = `${productKey}:${turnId}`
      if (seen.has(dedupe)) continue
      seen.add(dedupe)
      const modelId = str(row.model_id) || 'unknown'
      // created_at is epoch seconds on every build verified so far; tolerate ms
      records.push({
        tsMs: createdAt < 1e12 ? createdAt * 1000 : createdAt,
        modelId,
        input,
        output,
        cacheRead,
        cacheWrite,
      })
    }
  } finally {
    db.close()
  }
}

/** Fold the flat records into `tokscale graph`-shaped contributions */
function buildPayload(records: UsageRecord[]): unknown {
  const days = new Map<string, Map<string, Slice>>()
  for (const record of records) {
    const day = localDay(record.tsMs)
    let slices = days.get(day)
    if (!slices) {
      slices = new Map()
      days.set(day, slices)
    }
    const key = record.modelId
    const hit = slices.get(key) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 }
    hit.input += record.input
    hit.output += record.output
    hit.cacheRead += record.cacheRead
    hit.cacheWrite += record.cacheWrite
    hit.messages += 1
    slices.set(key, hit)
  }

  const contributions = [...days.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, slices]) => {
      const totals = { tokens: 0, cost: 0, messages: 0 }
      const tokenBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
      const clients = [...slices.entries()].map(([modelId, slice]) => {
        const tokens = {
          input: slice.input,
          output: slice.output,
          cacheRead: slice.cacheRead,
          cacheWrite: slice.cacheWrite,
        }
        const total = slice.input + slice.output + slice.cacheRead + slice.cacheWrite
        totals.tokens += total
        totals.messages += slice.messages
        tokenBreakdown.input += slice.input
        tokenBreakdown.output += slice.output
        tokenBreakdown.cacheRead += slice.cacheRead
        tokenBreakdown.cacheWrite += slice.cacheWrite
        // cost 0 on purpose: the main process prices entries from the
        // OpenRouter catalog like every other locally read client.
        return { client: CLIENT_ID, modelId, providerId: PROVIDER_ID, tokens, cost: 0, messages: slice.messages }
      })
      return { date, totals, tokenBreakdown, clients, intensity: 0, activeTimeMs: 0 }
    })

  return { meta: null, contributions }
}

// ===== aggregate cache (token counters only) =====

/**
 * The key only exists while the IDE runs, so without a replay cache the Trae
 * row would vanish every time the IDE closes. Only the aggregated tokscale
 * payload (dates + token counters + model ids) is persisted — never content,
 * never the key.
 */
async function readCache(userData: string): Promise<unknown | null> {
  try {
    const raw = await readFile(join(userData, 'trae-local', 'usage-cache.json'), 'utf8')
    const parsed = asRecord(JSON.parse(raw))
    return Array.isArray(parsed?.contributions) ? parsed : null
  } catch {
    return null
  }
}

async function writeCache(userData: string, payload: unknown): Promise<void> {
  try {
    await mkdir(join(userData, 'trae-local'), { recursive: true })
    await writeFile(join(userData, 'trae-local', 'usage-cache.json'), JSON.stringify(payload), 'utf8')
  } catch {
    // cache is a courtesy, never a failure
  }
}

/**
 * Read Trae CN / SOLO CN local usage into a `tokscale graph`-shaped payload.
 * Best-effort by contract: no running IDE, no compiler, a failed scan or a
 * changed encryption scheme all degrade to the cached aggregate (or null),
 * never to wrong numbers.
 */
export async function readTraeLocalUsage(home: string, userData: string): Promise<unknown | null> {
  try {
    const appData = process.env.APPDATA?.trim() || join(home, 'AppData', 'Roaming')
    const products: Array<{ dir: string; exe: string; dbPath: string }> = []
    for (const product of PRODUCTS) {
      const dbPath = join(appData, product.dir, DB_REL)
      try {
        if ((await stat(dbPath)).isFile()) products.push({ ...product, dbPath })
      } catch {
        // product not installed
      }
    }
    if (products.length === 0) return readCache(userData)

    const keyscanExe = await ensureKeyscanExe(userData)
    if (!keyscanExe) return readCache(userData)

    const records: UsageRecord[] = []
    const seen = new Set<string>()
    const tmpPrefix = join(userData, 'trae-local', `scan-${process.pid}-${Date.now()}`)
    for (const product of products) {
      const snapshot = `${tmpPrefix}-${product.exe.replace(/\s+/g, '')}.snap`
      const decrypted = `${tmpPrefix}-${product.exe.replace(/\s+/g, '')}.db`
      try {
        const encKey = await scanProductKey(keyscanExe, product.exe, product.dbPath)
        if (!encKey) continue
        if (!(await decryptDatabase(encKey, product.dbPath, snapshot, decrypted))) continue
        await readTurns(decrypted, product.dir, records, seen)
      } catch {
        // one broken product must not sink the other
      } finally {
        await rm(snapshot, { force: true }).catch(() => {})
        await rm(decrypted, { force: true }).catch(() => {})
      }
    }

    if (records.length === 0) return readCache(userData)
    const payload = buildPayload(records)
    await writeCache(userData, payload)
    return payload
  } catch {
    return readCache(userData)
  }
}
