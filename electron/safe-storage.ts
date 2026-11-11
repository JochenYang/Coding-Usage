import { spawn } from 'node:child_process'
import { createDecipheriv } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Read another Electron app's `safeStorage` secret on Windows.
 *
 * `safeStorage` cannot be asked to decrypt a value it did not encrypt — the API
 * only knows this app's own key (verified against Qoder's blob). Chromium's
 * Windows path keeps the per-app AES key DPAPI-protected inside the app's
 * `Local State` (`os_crypt.encrypted_key`), so the key is unwrapped through
 * DPAPI once and the secret is then decrypted in-process. Both steps are pure
 * reads: nothing is written and no credential leaves the machine.
 *
 * Windows only: macOS keeps the equivalent key in the Login keychain and Linux
 * in the secret service, neither of which is implemented here, so callers on
 * those platforms report a "cannot read here" state instead of "no login".
 *
 * Shared by the Qoder and Cursor quota probes — the envelope is the same
 * Chromium `v10` container, only the app directory differs.
 */

/** The wrapped-key prefix Chromium writes for a DPAPI-protected key */
const DPAPI_PREFIX = 'DPAPI'
/** AES-256-GCM: 12-byte nonce, 16-byte tag, all behind a 3-byte version tag */
const V10_PREFIX = 'v10'
const V10_NONCE_BYTES = 12
const V10_TAG_BYTES = 16
const AES_KEY_BYTES = 32

const DPAPI_TIMEOUT_MS = 10_000

/**
 * DPAPI unwrap script, read by the child from stdin so the wrapped key never
 * appears on a command line (`Win32_Process.CommandLine` is readable by other
 * processes and by admin tooling).
 */
const DPAPI_SCRIPT = `
Add-Type -AssemblyName System.Security
$b = [Convert]::FromBase64String('$KEY')
$p = [System.Security.Cryptography.ProtectedData]::Unprotect($b, $null, 'CurrentUser')
[Convert]::ToBase64String($p)
`.trim()

/**
 * DPAPI-unwrap a wrapped key through a short-lived PowerShell child.
 *
 * Resolves null on every failure (no PowerShell, blocked by policy, a different
 * user's DPAPI blob) — the caller reports "cannot decrypt" rather than guessing.
 */
export function unwrapDpapiKey(wrapped: Buffer): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', '-'], {
      windowsHide: true,
    })
    let out = ''
    let settled = false
    const finish = (value: Buffer | null): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, DPAPI_TIMEOUT_MS)
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      out += chunk
    })
    // PowerShell writes its own diagnostics on stderr; drained, never parsed
    child.stderr?.resume()
    child.on('error', () => finish(null))
    // A failed spawn destroys the pipe: writing to it would raise an unhandled
    // stream error instead of the null this function promises.
    child.stdin?.on('error', () => finish(null))
    child.on('close', () => {
      // Take the last non-empty line and insist it is base64: a stray warning on
      // stdout must not be decoded into garbage bytes that fail authentication
      // later and read as "this app cannot decrypt" forever.
      const line = out
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l !== '')
        .pop()
      if (!line || !/^[A-Za-z0-9+/]+={0,2}$/.test(line)) return finish(null)
      finish(Buffer.from(line, 'base64'))
    })
    child.stdin?.end(DPAPI_SCRIPT.replace('$KEY', wrapped.toString('base64')))
  })
}

/**
 * Decrypt one Chromium `v10` blob (AES-256-GCM) with a 32-byte key.
 *
 * Returns null when the envelope is not `v10`, is truncated, or fails
 * authentication — a wrong key and a corrupted blob are indistinguishable and
 * neither is retried here.
 */
export function decryptChromiumV10(blob: Buffer, key: Buffer): string | null {
  if (key.length !== AES_KEY_BYTES) return null
  if (blob.subarray(0, 3).toString('latin1') !== V10_PREFIX) return null
  if (blob.length < 3 + V10_NONCE_BYTES + V10_TAG_BYTES) return null
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(3, 3 + V10_NONCE_BYTES))
    decipher.setAuthTag(blob.subarray(blob.length - V10_TAG_BYTES))
    return Buffer.concat([
      decipher.update(blob.subarray(3 + V10_NONCE_BYTES, blob.length - V10_TAG_BYTES)),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    return null
  }
}

/**
 * The app's 32-byte Chromium key, DPAPI-unwrapped from `<userData>/Local State`.
 *
 * `null` covers every reason it cannot be obtained — wrong platform, no such
 * file, no `os_crypt` entry, a non-DPAPI (macOS/Linux) envelope, or a DPAPI
 * failure. The callers treat all of them the same way: unreadable here.
 */
export async function readChromiumKey(userDataDir: string): Promise<Buffer | null> {
  if (process.platform !== 'win32') return null
  let localState: unknown
  try {
    localState = JSON.parse(await readFile(join(userDataDir, 'Local State'), 'utf8'))
  } catch {
    return null
  }
  const osCrypt =
    localState != null && typeof localState === 'object'
      ? (localState as { os_crypt?: unknown }).os_crypt
      : null
  const encoded =
    osCrypt != null && typeof osCrypt === 'object'
      ? (osCrypt as { encrypted_key?: unknown }).encrypted_key
      : null
  if (typeof encoded !== 'string' || encoded === '') return null
  const wrapped = Buffer.from(encoded, 'base64')
  if (wrapped.subarray(0, 5).toString('latin1') !== DPAPI_PREFIX) return null
  const key = await unwrapDpapiKey(wrapped.subarray(5))
  return key && key.length === AES_KEY_BYTES ? key : null
}

/**
 * Decrypt an app secret that sits in a `v10` blob inside that app's userData.
 *
 * Convenience wrapper for probes whose secret file is a raw `v10` buffer.
 */
export async function readSealedSecret(
  userDataDir: string,
  blob: Buffer,
): Promise<string | null> {
  const key = await readChromiumKey(userDataDir)
  if (!key) return null
  return decryptChromiumV10(blob, key)
}