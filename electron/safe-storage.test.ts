import { createCipheriv } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decryptChromiumV10 } from './safe-storage'

/**
 * The DPAPI half needs a real Windows user profile, so it is verified on a live
 * install instead (Qoder's and Cursor's stores both decrypt there). This file
 * pins the part that must hold everywhere: the `v10` AES-256-GCM envelope, whose
 * nonce/tag layout is the whole reason a wrong key fails loudly rather than
 * returning garbage.
 */

const KEY = Buffer.alloc(32, 9)

/** Build a Chromium `v10` blob: version tag, nonce, ciphertext, auth tag */
function seal(plain: string, key: Buffer = KEY, nonce = Buffer.alloc(12, 7)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()])
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, cipher.getAuthTag()])
}

describe('decryptChromiumV10', () => {
  it('recovers the plaintext from a v10 envelope', () => {
    expect(decryptChromiumV10(seal('a-stored-secret'), KEY)).toBe('a-stored-secret')
  })

  it('rejects a wrong key instead of returning garbage', () => {
    expect(decryptChromiumV10(seal('a-stored-secret'), Buffer.alloc(32, 1))).toBeNull()
  })

  it('rejects a key that is not AES-256 sized', () => {
    expect(decryptChromiumV10(seal('a-stored-secret'), Buffer.alloc(16, 9))).toBeNull()
  })

  it('rejects an envelope that is not v10 or is truncated', () => {
    const blob = seal('a-stored-secret')
    expect(decryptChromiumV10(Buffer.concat([Buffer.from('v11', 'latin1'), blob.subarray(3)]), KEY)).toBeNull()
    expect(decryptChromiumV10(blob.subarray(0, 20), KEY)).toBeNull()
    expect(decryptChromiumV10(Buffer.alloc(0), KEY)).toBeNull()
  })
})