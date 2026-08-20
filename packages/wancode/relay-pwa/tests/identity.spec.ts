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
  bindPwaRelayAsyncIdentityStorage,
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
    async get() {
      return value
    },
    async set(next) {
      value = next
    },
    async clear() {
      value = undefined
    },
  }
}

describe('PWA device identity store', () => {
  it('mints a WebCrypto identity once and peeks only public fields', async () => {
    const storage = memoryStorage()
    expect(await peekPwaRelayPublicIdentity(storage)).toBeUndefined()
    const first = await loadPwaRelayIdentity(storage)
    const second = await loadPwaRelayIdentity(storage)
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.keyPair.publicKey).toBe(first.keyPair.publicKey)
    const published = await peekPwaRelayPublicIdentity(storage)
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
    await expectRelayErrorAsync(
      () => peekPwaRelayPublicIdentity(memoryStorage(JSON.stringify(poisoned))),
      'plaintext',
    )
  })

  it('binds a keyed store and refuses the origin or credential slots', async () => {
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
    expect(await storage.get()).toBeUndefined()
    await storage.set('identity-blob')
    expect(items.get(PWA_RELAY_IDENTITY_STORAGE_KEY)).toBe('identity-blob')
    await storage.clear()
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

  it('refuses sessionStorage and loads identity from an async key/value store', async () => {
    const session = {
      getItem(_key: string) {
        return null
      },
      setItem(_key: string, _value: string) {},
      removeItem(_key: string) {},
    }
    const host = globalThis as unknown as { sessionStorage?: typeof session }
    const previous = host.sessionStorage
    host.sessionStorage = session
    try {
      expectRelayError(() => bindPwaRelayIdentityStorage(session), 'malformed')
    } finally {
      if (previous === undefined) {
        delete host.sessionStorage
      } else {
        host.sessionStorage = previous
      }
    }
    const values = new Map<string, string>()
    const storage = bindPwaRelayAsyncIdentityStorage({
      async get(key) {
        return values.get(key)
      },
      async put(key, value) {
        values.set(key, value)
      },
      async delete(key) {
        values.delete(key)
      },
    })
    const first = await loadPwaRelayIdentity(storage)
    expect(values.get(PWA_RELAY_IDENTITY_STORAGE_KEY)).toContain(first.deviceId)
    expect((await peekPwaRelayPublicIdentity(storage))?.deviceId).toBe(first.deviceId)
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
