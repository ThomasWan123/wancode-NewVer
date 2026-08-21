import { describe, expect, it } from 'vitest'
import {
  RelayAuthorizationError,
  createStoredDeviceIdentity,
  serializeStoredDeviceIdentity,
} from '../../relay-protocol/src/index.ts'
import {
  PWA_RELAY_IDENTITY_STORAGE_KEY,
  PWA_RELAY_ORIGIN_STORAGE_KEY,
  PWA_RELAY_IDENTITY_DB,
  PWA_RELAY_IDENTITY_STORE,
  bindPwaRelayIdentityStorage,
  bindPwaRelayAsyncIdentityStorage,
  openPwaRelayIdentityIndexedDb,
  loadPwaRelayIdentity,
  peekPwaRelayPublicIdentity,
  resolvePwaRelayIdentity,
  enrollPwaPairingShell,
  forgetPwaPairingOrigin,
  type PwaRelayIdentityStorage,
  type PwaRelayIndexedDbFactory,
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

  it('resolves exactly one of a supplied identity, storage, or IndexedDB', async () => {
    const identity = createStoredDeviceIdentity()
    expect(await resolvePwaRelayIdentity({ identity })).toBe(identity)
    const storage = memoryStorage()
    const minted = await resolvePwaRelayIdentity({ identityStorage: storage })
    expect(minted.deviceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(await resolvePwaRelayIdentity({ identityStorage: storage })).toEqual(minted)
    const indexedDB = memoryIndexedDb()
    const fromDb = await resolvePwaRelayIdentity({ indexedDB })
    expect(fromDb.deviceId).toMatch(/^[0-9a-f]{32}$/u)
    expect((await resolvePwaRelayIdentity({ indexedDB })).deviceId).toBe(fromDb.deviceId)
    await expectRelayErrorAsync(() => resolvePwaRelayIdentity({}), 'malformed')
    await expectRelayErrorAsync(
      () => resolvePwaRelayIdentity({ identity, identityStorage: storage }),
      'malformed',
    )
    await expectRelayErrorAsync(
      () => resolvePwaRelayIdentity({ identity, indexedDB }),
      'malformed',
    )
  })

  it('enrolls from global IndexedDB when no identity is supplied', async () => {
    const indexedDB = memoryIndexedDb()
    const host = globalThis as unknown as { indexedDB?: PwaRelayIndexedDbFactory }
    const previous = host.indexedDB
    host.indexedDB = indexedDB
    try {
      const first = await resolvePwaRelayIdentity({})
      expect(first.deviceId).toMatch(/^[0-9a-f]{32}$/u)
      expect((await resolvePwaRelayIdentity({})).deviceId).toBe(first.deviceId)
    } finally {
      if (previous === undefined) {
        delete host.indexedDB
      } else {
        host.indexedDB = previous
      }
    }
  })

  it('opens IndexedDB identity storage and refuses a missing factory', async () => {
    await expectRelayErrorAsync(
      () => openPwaRelayIdentityIndexedDb({} as PwaRelayIndexedDbFactory),
      'malformed',
    )
    const indexedDB = memoryIndexedDb()
    const storage = await openPwaRelayIdentityIndexedDb(indexedDB)
    const first = await loadPwaRelayIdentity(storage)
    const second = await loadPwaRelayIdentity(await openPwaRelayIdentityIndexedDb(indexedDB))
    expect(second.deviceId).toBe(first.deviceId)
    expect((await peekPwaRelayPublicIdentity(storage))?.deviceId).toBe(first.deviceId)
    expect(PWA_RELAY_IDENTITY_DB).toBe('wancode-relay-identity')
    expect(PWA_RELAY_IDENTITY_STORE).toBe('device')
  })

  it('enrolls a pairing origin into sessionStorage and identity into IndexedDB', async () => {
    const items = new Map<string, string>()
    const session = {
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
    const indexedDB = memoryIndexedDb()
    const first = await enrollPwaPairingShell({
      origin: 'https://pwa.wancode.example/',
      sessionStorage: session,
      indexedDB,
    })
    expect(first.origin).toBe('https://pwa.wancode.example')
    expect(first.deviceId).toMatch(/^[0-9a-f]{32}$/u)
    expect(items.get(PWA_RELAY_ORIGIN_STORAGE_KEY)).toBe(first.origin)
    expect(items.has(PWA_RELAY_IDENTITY_STORAGE_KEY)).toBe(false)
    expect(JSON.stringify(first)).not.toMatch(/privateKey|encryptionPrivateKey/)
    forgetPwaPairingOrigin(session)
    expect(items.has(PWA_RELAY_ORIGIN_STORAGE_KEY)).toBe(false)
    const second = await enrollPwaPairingShell({
      origin: 'https://pwa.wancode.example/',
      sessionStorage: session,
      indexedDB,
    })
    expect(second.deviceId).toBe(first.deviceId)
    expect(second.publicKey).toBe(first.publicKey)
    await expectRelayErrorAsync(
      () => enrollPwaPairingShell({
        origin: 'https://pwa.wancode.example/#access_token=tok-live',
        sessionStorage: session,
        indexedDB,
      }),
      'plaintext',
    )
    expect(items.has(PWA_RELAY_ORIGIN_STORAGE_KEY)).toBe(false)
  })
})

function memoryIndexedDb(): PwaRelayIndexedDbFactory {
  const values = new Map<string, string>()
  const stores = new Set<string>()
  const db = {
    objectStoreNames: {
      contains(name: string) {
        return stores.has(name)
      },
    },
    createObjectStore(name: string) {
      stores.add(name)
      return undefined
    },
    transaction() {
      return {
        objectStore() {
          return {
            get(key: string) {
              return idbRequest(() => values.get(key))
            },
            put(value: string, key: string) {
              return idbRequest(() => {
                values.set(key, value)
                return undefined
              })
            },
            delete(key: string) {
              return idbRequest(() => {
                values.delete(key)
                return undefined
              })
            },
          }
        },
      }
    },
  }
  return {
    open(name: string, version: number) {
      if (name.length === 0 || version < 1) throw new Error('indexeddb')
      const request = {
        result: db,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      }
      queueMicrotask(() => {
        request.onupgradeneeded?.()
        request.onsuccess?.()
      })
      return request
    },
  }
}

function idbRequest<T>(run: () => T): {
  result: T
  onsuccess: (() => void) | null
  onerror: (() => void) | null
} {
  const request = {
    result: undefined as T,
    onsuccess: null as (() => void) | null,
    onerror: null as (() => void) | null,
  }
  queueMicrotask(() => {
    request.result = run()
    request.onsuccess?.()
  })
  return request
}
