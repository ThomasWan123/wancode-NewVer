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

/** Pairing page origin slot. Identity must never share this key. */
export const PWA_RELAY_ORIGIN_STORAGE_KEY = 'wancode-relay-origin'

/** Default slot for a serialized device identity. Not sessionStorage. */
export const PWA_RELAY_IDENTITY_STORAGE_KEY = 'wancode-relay-identity'

const CREDENTIAL_STORAGE_KEY = /token|secret|credential|password|authorization/iu

/** Opaque string store used to persist one device identity. */
export interface PwaRelayIdentityStorage {
  get(): string | undefined
  set(value: string): void
  clear(): void
}

/** Web Storage-shaped adapter used by `bindPwaRelayIdentityStorage`. */
export interface PwaRelayKeyedStorage {
  readonly getItem: (key: string) => string | null
  readonly setItem: (key: string, value: string) => void
  readonly removeItem: (key: string) => void
}

/**
 * Bind identity to a keyed store. The origin sessionStorage key and
 * credential-like keys fail closed so private keys cannot share that slot.
 */
export function bindPwaRelayIdentityStorage(
  storage: PwaRelayKeyedStorage,
  key = PWA_RELAY_IDENTITY_STORAGE_KEY,
): PwaRelayIdentityStorage {
  assertPwaIdentityStorageKey(key)
  return {
    get() {
      const value = storage.getItem(key)
      return value === null || value === '' ? undefined : value
    },
    set(value) {
      storage.setItem(key, value)
    },
    clear() {
      storage.removeItem(key)
    },
  }
}

/**
 * Mint a WebCrypto identity when the store is empty, otherwise reload it.
 * Model credentials in the stored JSON fail closed. sessionStorage is not used.
 */
export async function loadPwaRelayIdentity(
  storage: PwaRelayIdentityStorage,
): Promise<StoredDeviceIdentity> {
  const existing = readStoredIdentity(storage)
  if (existing === undefined) {
    const minted = await createWebCryptoDeviceIdentity()
    storage.set(serializeStoredDeviceIdentity(minted))
    return minted
  }
  return parseStoredPwaIdentity(existing)
}

/**
 * Return the public identity if one is stored. Empty stores return undefined.
 * Private keys never appear on the result.
 */
export function peekPwaRelayPublicIdentity(
  storage: PwaRelayIdentityStorage,
): PublicDeviceIdentity | undefined {
  const existing = readStoredIdentity(storage)
  if (existing === undefined) return undefined
  return publicDeviceIdentity(parseStoredPwaIdentity(existing))
}

function readStoredIdentity(storage: PwaRelayIdentityStorage): string | undefined {
  const existing = storage.get()
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
