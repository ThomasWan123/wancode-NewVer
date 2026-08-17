import { describe, expect, it } from 'vitest'
import {
  parseAuthenticodeResult,
  type AuthenticodeProbeResult,
} from '../src/windows-signature.ts'

describe('Windows Authenticode verification', () => {
  it('accepts only a valid signature with a signer certificate', () => {
    const result = parseAuthenticodeResult(JSON.stringify({
      Status: 'Valid',
      Subject: 'CN=Wancode Software',
      Thumbprint: '001122AABBCC',
    }))

    expect(result).toEqual({
      subject: 'CN=Wancode Software',
      thumbprint: '001122AABBCC',
    })
  })

  it.each([
    [{ Status: 'NotSigned', Subject: '', Thumbprint: '' }, 'NotSigned'],
    [{ Status: 'HashMismatch', Subject: 'CN=Attacker', Thumbprint: 'AA' }, 'HashMismatch'],
    [{ Status: 'Valid', Subject: '', Thumbprint: 'AA' }, 'signer certificate'],
    [{ Status: 'Valid', Subject: 'CN=Wancode', Thumbprint: '' }, 'thumbprint'],
  ] as const)('rejects an untrusted probe result', (value, expected) => {
    expect(() => parseAuthenticodeResult(JSON.stringify(value))).toThrow(expected)
  })

  it('rejects malformed PowerShell output without echoing it', () => {
    const secret = 'untrusted-output-secret'
    expect(() => parseAuthenticodeResult(secret)).toThrow('invalid JSON')
    try {
      parseAuthenticodeResult(secret)
    } catch (error) {
      expect(String(error)).not.toContain(secret)
    }
  })
})

// Compile-time guard: the process boundary never needs installer contents.
const _probe: AuthenticodeProbeResult = { subject: 'CN=Example', thumbprint: 'AA' }
void _probe
