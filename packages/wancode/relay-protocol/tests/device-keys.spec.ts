import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createStoredDeviceIdentity,
  generateDeviceKeyPair,
  parseStoredDeviceIdentity,
  publicDeviceIdentity,
  serializeStoredDeviceIdentity,
} from '../src/index.ts'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('stored device identity', () => {
  it('round-trips a generated identity and keeps private keys off the public view', () => {
    const stored = createStoredDeviceIdentity()
    const raw = serializeStoredDeviceIdentity(stored)
    const parsed = parseStoredDeviceIdentity(raw)
    const published = publicDeviceIdentity(parsed)

    expect(parsed.deviceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(parsed.keyPair).toEqual(stored.keyPair)
    expect(published).toEqual({
      deviceId: stored.deviceId,
      publicKey: stored.keyPair.publicKey,
      encryptionPublicKey: stored.keyPair.encryptionPublicKey,
    })
    expect(JSON.stringify(published)).not.toContain(stored.keyPair.privateKey)
    expect(JSON.stringify(published)).not.toContain(stored.keyPair.encryptionPrivateKey)
    expect(raw).toContain(stored.keyPair.privateKey)
  })

  it('refuses plaintext fields, missing private keys, and mutated public keys', () => {
    const stored = createStoredDeviceIdentity(generateDeviceKeyPair(), 'a'.repeat(32))
    const raw = JSON.parse(serializeStoredDeviceIdentity(stored)) as Record<string, unknown>
    expectRelayError(
      () => parseStoredDeviceIdentity(JSON.stringify({ ...raw, prompt: 'delete all files' })),
      'plaintext',
    )
    expectRelayError(
      () => parseStoredDeviceIdentity(JSON.stringify({ ...raw, privateKey: undefined })),
      'untrusted-key',
    )
    expectRelayError(
      () => parseStoredDeviceIdentity(JSON.stringify({
        ...raw,
        publicKey: generateDeviceKeyPair().publicKey,
      })),
      'untrusted-key',
    )
  })
})
