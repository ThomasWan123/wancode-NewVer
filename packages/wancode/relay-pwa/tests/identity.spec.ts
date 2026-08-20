import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createStoredDeviceIdentity,
  serializeStoredDeviceIdentity,
} from '../../relay-protocol/src/index.ts'
import {
  PWA_RELAY_IDENTITY_STORAGE_KEY,
  PWA_RELAY_ORIGIN_STORAGE_KEY,
  bindPwaRelayIdentityStorage,
  loadPwaRelayIdentity,
  peekPwaRelayPublicIdentity,
  resolvePwaRelayIdentity,
  type PwaRelayIdentityStorage,
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

async function expectRelayErrorAsync(run: () => Promise<unknown>, code: string): Promise<void> {
  try {
    await run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

function memoryStorage(initial?: string): PwaRelayIdentityStorage {
  let value = initial
  return {
    get() {
      return value
    },
    set(next) {
      value = next
    },
    clear() {
      value = undefined
    },
  }
}

describe('PWA device identity store', () => {
  it('mints a WebCrypto identity once and peeks only public fields', async () => {
    const storage = memoryStorage()
    expect(peekPwaRelayPublicIdentity(storage)).toBeUndefined()
    const first = await loadPwaRelayIdentity(storage)
    const second = await loadPwaRelayIdentity(storage)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.keyPair.publicKey).toBe(first.keyPair.publicKey)
    const published = peekPwaRelayPublicIdentity(storage)
    expect(published).toEqual({
      deviceId: first.deviceId,
      publicKey: first.keyPair.publicKey,
      encryptionPublicKey: first.keyPair.encryptionPublicKey,
    })
    expect(JSON.stringify(published)).not.toMatch(/privateKey|encryptionPrivateKey/)
  })

  it('refuses stored model credentials before the identity is reloaded', async () => {
    const identity = await loadPwaRelayIdentity(memoryStorage())
    const poisoned = JSON.parse(serializeStoredDeviceIdentity(identity)) as Record<string, unknown>
    poisoned.DEEPSEEK_API_KEY = 'sk-secret'
    await expectRelayErrorAsync(
      () => loadPwaRelayIdentity(memoryStorage(JSON.stringify(poisoned))),
      'plaintext',
    )
    expectRelayError(
      () => peekPwaRelayPublicIdentity(memoryStorage(JSON.stringify(poisoned))),
      'plaintext',
    )
  })

  it('binds a keyed store and refuses the origin or credential slots', () => {
    const items = new Map<string, string>()
    const web = {
      getItem(key: string) {
        return items.get(key) ?? null
      },
      setItem(key: string, value: string) {
        items.set(key, value)
      },
      removeItem(key: string) {
        items.delete(key)
      },
    }
    const storage = bindPwaRelayIdentityStorage(web)
    expect(storage.get()).toBeUndefined()
    storage.set('identity-blob')
    expect(items.get(PWA_RELAY_IDENTITY_STORAGE_KEY)).toBe('identity-blob')
    storage.clear()
    expect(items.has(PWA_RELAY_IDENTITY_STORAGE_KEY)).toBe(false)
    expectRelayError(
      () => bindPwaRelayIdentityStorage(web, PWA_RELAY_ORIGIN_STORAGE_KEY),
      'malformed',
    )
    expectRelayError(
      () => bindPwaRelayIdentityStorage(web, 'access_token'),
      'plaintext',
    )
  })

  it('resolves exactly one of a supplied identity or a storage load', async () => {
    const identity = createStoredDeviceIdentity()
    expect(await resolvePwaRelayIdentity({ identity })).toBe(identity)
    const storage = memoryStorage()
    const minted = await resolvePwaRelayIdentity({ identityStorage: storage })
    expect(minted.deviceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(await resolvePwaRelayIdentity({ identityStorage: storage })).toEqual(minted)
    await expectRelayErrorAsync(() => resolvePwaRelayIdentity({}), 'malformed')
    await expectRelayErrorAsync(
      () => resolvePwaRelayIdentity({ identity, identityStorage: storage }),
      'malformed',
    )
  })
})
