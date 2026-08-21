/** Durable PWA device identity. Private keys stay in caller-supplied storage. */

import {
  RelayAuthorizationError,
  createWebCryptoDeviceIdentity,
  parseStoredDeviceIdentity,
  publicDeviceIdentity,
  serializeStoredDeviceIdentity,
  type PublicDeviceIdentity,
  type StoredDeviceIdentity,
} from '../../relay-protocol/src/index.ts'
import { assertPwaModelCredentials } from './credentials.ts'
import { assertPwaShellOrigin } from './shell.ts'

/** Pairing page origin slot. Identity must never share this key. */
export const PWA_RELAY_ORIGIN_STORAGE_KEY = 'wancode-relay-origin'

/** Default slot for a serialized device identity. Not sessionStorage. */
export const PWA_RELAY_IDENTITY_STORAGE_KEY = 'wancode-relay-identity'

const CREDENTIAL_STORAGE_KEY = /token|secret|credential|password|authorization/iu

/** Opaque string store used to persist one device identity. */
export interface PwaRelayIdentityStorage {
  get(): Promise<string | undefined>
  set(value: string): Promise<void>
  clear(): Promise<void>
}

/** Web Storage-shaped adapter used by `bindPwaRelayIdentityStorage`. */
export interface PwaRelayKeyedStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

/** Async key/value adapter used by IndexedDB-backed identity storage. */
export interface PwaRelayAsyncKv {
  readonly get: (key: string) => Promise<string | undefined>
  readonly put: (key: string, value: string) => Promise<void>
  readonly delete: (key: string) => Promise<void>
}

/** IndexedDB database name for the PWA device identity blob. */
export const PWA_RELAY_IDENTITY_DB = 'wancode-relay-identity'

/** Object store that holds the serialized identity. */
export const PWA_RELAY_IDENTITY_STORE = 'device'

/** Minimal IndexedDB request used without DOM lib types. */
export interface PwaRelayIndexedDbRequest<T> {
  result: T
  onsuccess: (() => void) | null
  onerror: (() => void) | null
}

/** Minimal IndexedDB database used without DOM lib types. */
export interface PwaRelayIndexedDatabase {
  readonly objectStoreNames: { contains(name: string): boolean }
  createObjectStore(name: string): unknown
  transaction(store: string, mode: 'readonly' | 'readwrite'): {
    objectStore(name: string): {
      get(key: string): PwaRelayIndexedDbRequest<unknown>
      put(value: string, key: string): PwaRelayIndexedDbRequest<unknown>
      delete(key: string): PwaRelayIndexedDbRequest<unknown>
    }
  }
}

/** Minimal IndexedDB factory used without DOM lib types. */
export interface PwaRelayIndexedDbFactory {
  open(name: string, version: number): PwaRelayIndexedDbRequest<PwaRelayIndexedDatabase> & {
    onupgradeneeded: (() => void) | null
  }
}

/**
 * Bind identity to a keyed store. sessionStorage, the origin key, and
 * credential-like keys fail closed so private keys cannot share that slot.
 */
export function bindPwaRelayIdentityStorage(
  storage: PwaRelayKeyedStorage,
  key = PWA_RELAY_IDENTITY_STORAGE_KEY,
): PwaRelayIdentityStorage {
  assertNotSessionStorage(storage)
  assertPwaIdentityStorageKey(key)
  return {
    async get() {
      const value = storage.getItem(key)
      return value === null || value === '' ? undefined : value
    },
    async set(value) {
      storage.setItem(key, value)
    },
    async clear() {
      storage.removeItem(key)
    },
  }
}

/**
 * Bind identity to an async key/value store such as IndexedDB. The origin
 * sessionStorage key and credential-like keys fail closed.
 */
export function bindPwaRelayAsyncIdentityStorage(
  storage: PwaRelayAsyncKv,
  key = PWA_RELAY_IDENTITY_STORAGE_KEY,
): PwaRelayIdentityStorage {
  assertPwaIdentityStorageKey(key)
  return {
    async get() {
      const value = await storage.get(key)
      return value === undefined || value === '' ? undefined : value
    },
    async set(value) {
      await storage.put(key, value)
    },
    async clear() {
      await storage.delete(key)
    },
  }
}

/**
 * Open IndexedDB-backed identity storage. Missing IndexedDB fails closed.
 * Private keys never go to sessionStorage.
 */
export async function openPwaRelayIdentityIndexedDb(
  indexedDB: PwaRelayIndexedDbFactory,
): Promise<PwaRelayIdentityStorage> {
  if (indexedDB === null || typeof indexedDB !== 'object' || typeof indexedDB.open !== 'function') {
    throw new RelayAuthorizationError('malformed', 'pwa identity indexeddb is required')
  }
  const db = await openIdentityDatabase(indexedDB)
  return bindPwaRelayAsyncIdentityStorage({
    async get(key) {
      const value = await settleIndexedDbRequest(objectStore(db, 'readonly').get(key))
      if (value === undefined || value === '') return undefined
      if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) {
        throw new RelayAuthorizationError('malformed', 'pwa relay identity is required')
      }
      return value
    },
    async put(key, value) {
      await settleIndexedDbRequest(objectStore(db, 'readwrite').put(value, key))
    },
    async delete(key) {
      await settleIndexedDbRequest(objectStore(db, 'readwrite').delete(key))
    },
  })
}

/**
 * Mint a WebCrypto identity when the store is empty, otherwise reload it.
 * Model credentials in the stored JSON fail closed. sessionStorage is not used.
 */
export async function loadPwaRelayIdentity(
  storage: PwaRelayIdentityStorage,
): Promise<StoredDeviceIdentity> {
  const existing = await readStoredIdentity(storage)
  if (existing === undefined) {
    const minted = await createWebCryptoDeviceIdentity()
    await storage.set(serializeStoredDeviceIdentity(minted))
    return minted
  }
  return parseStoredPwaIdentity(existing)
}

/**
 * Return the public identity if one is stored. Empty stores return undefined.
 * Private keys never appear on the result.
 */
export async function peekPwaRelayPublicIdentity(
  storage: PwaRelayIdentityStorage,
): Promise<PublicDeviceIdentity | undefined> {
  const existing = await readStoredIdentity(storage)
  if (existing === undefined) return undefined
  return publicDeviceIdentity(parseStoredPwaIdentity(existing))
}

/**
 * Load identity from storage, IndexedDB, or a caller-supplied blob.
 * Supplying more than one source fails closed. With none, the global
 * IndexedDB factory is used when present.
 */
export async function resolvePwaRelayIdentity(input: {
  readonly identity?: StoredDeviceIdentity
  readonly identityStorage?: PwaRelayIdentityStorage
  readonly indexedDB?: PwaRelayIndexedDbFactory
}): Promise<StoredDeviceIdentity> {
  const identity = input.identity
  const storage = input.identityStorage
  const indexedDB = input.indexedDB
  if ([identity, storage, indexedDB].filter(value => value !== undefined).length > 1) {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity must not be supplied twice')
  }
  if (storage !== undefined) return loadPwaRelayIdentity(storage)
  if (identity !== undefined) return identity
  const factory = indexedDB ?? globalIndexedDb()
  if (factory !== undefined) {
    return loadPwaRelayIdentity(await openPwaRelayIdentityIndexedDb(factory))
  }
  throw new RelayAuthorizationError('malformed', 'pwa relay identity is required')
}

/** Public pairing result. Private keys stay in IndexedDB. */
export interface PwaPairingEnrollment {
  readonly origin: string
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
}

/**
 * Remember a fail-closed relay origin in sessionStorage and mint or reload
 * the PWA identity from IndexedDB. Identity never uses the origin key.
 */
export async function enrollPwaPairingShell(input: {
  readonly origin: string
  readonly sessionStorage: PwaRelayKeyedStorage
  readonly indexedDB: PwaRelayIndexedDbFactory
}): Promise<PwaPairingEnrollment> {
  let origin: string
  try {
    origin = assertPwaShellOrigin(input.origin).origin
  } catch (cause) {
    try {
      input.sessionStorage.removeItem(PWA_RELAY_ORIGIN_STORAGE_KEY)
    } catch {
      // Origin slot is best-effort on failure.
    }
    throw cause
  }
  input.sessionStorage.setItem(PWA_RELAY_ORIGIN_STORAGE_KEY, origin)
  const published = publicDeviceIdentity(
    await loadPwaRelayIdentity(await openPwaRelayIdentityIndexedDb(input.indexedDB)),
  )
  return {
    origin,
    deviceId: published.deviceId,
    publicKey: published.publicKey,
    encryptionPublicKey: published.encryptionPublicKey,
  }
}

async function readStoredIdentity(storage: PwaRelayIdentityStorage): Promise<string | undefined> {
  const existing = await storage.get()
  if (existing === undefined || existing === '') return undefined
  if (typeof existing !== 'string' || /[\0\r\n]/u.test(existing)) {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity is required')
  }
  return existing
}

function parseStoredPwaIdentity(raw: string): StoredDeviceIdentity {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity must be an object')
  }
  assertPwaModelCredentials(parsed as Record<string, unknown>, 'pwa relay identity')
  return parseStoredDeviceIdentity(raw)
}

function globalIndexedDb(): PwaRelayIndexedDbFactory | undefined {
  const candidate = (globalThis as { indexedDB?: PwaRelayIndexedDbFactory }).indexedDB
  if (candidate === undefined || typeof candidate.open !== 'function') return undefined
  return candidate
}

function assertNotSessionStorage(storage: PwaRelayKeyedStorage): void {
  const session = (globalThis as { sessionStorage?: PwaRelayKeyedStorage }).sessionStorage
  if (session !== undefined && storage === session) {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity must not use sessionStorage')
  }
}

async function openIdentityDatabase(
  indexedDB: PwaRelayIndexedDbFactory,
): Promise<PwaRelayIndexedDatabase> {
  let request: ReturnType<PwaRelayIndexedDbFactory['open']>
  try {
    request = indexedDB.open(PWA_RELAY_IDENTITY_DB, 1)
  } catch {
    throw new RelayAuthorizationError('malformed', 'pwa identity indexeddb failed')
  }
  return new Promise((resolve, reject) => {
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(PWA_RELAY_IDENTITY_STORE)) {
        db.createObjectStore(PWA_RELAY_IDENTITY_STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      reject(new RelayAuthorizationError('malformed', 'pwa identity indexeddb failed'))
    }
  })
}

function objectStore(db: PwaRelayIndexedDatabase, mode: 'readonly' | 'readwrite') {
  return db.transaction(PWA_RELAY_IDENTITY_STORE, mode).objectStore(PWA_RELAY_IDENTITY_STORE)
}

function settleIndexedDbRequest<T>(request: PwaRelayIndexedDbRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => {
      reject(new RelayAuthorizationError('malformed', 'pwa identity indexeddb failed'))
    }
  })
}

function assertPwaIdentityStorageKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || /[\0\r\n]/u.test(key)) {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity storage key is required')
  }
  if (key === PWA_RELAY_ORIGIN_STORAGE_KEY) {
    throw new RelayAuthorizationError('malformed', 'pwa relay identity must not use the origin storage key')
  }
  if (CREDENTIAL_STORAGE_KEY.test(key)) {
    throw new RelayAuthorizationError('plaintext', 'pwa relay identity storage key must not carry credentials')
  }
}
