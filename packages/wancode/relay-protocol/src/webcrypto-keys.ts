/** WebCrypto device keys. This module does not import `node:crypto`. */

import type { DeviceKeyPair } from './device-keys.ts'
import { RelayAuthorizationError } from './errors.ts'

/** Hex device-id length produced by WebCrypto. */
export const RELAY_DEVICE_ID_BYTES = 16

type WebCryptoSubtle = NonNullable<typeof globalThis.crypto>['subtle']

/**
 * Create a 32-hex device id with WebCrypto so a PWA does not import
 * `node:crypto`. Missing WebCrypto fails closed.
 */
export function createWebCryptoDeviceId(): string {
  const crypto = globalThis.crypto
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay device id requires webcrypto')
  }
  const bytes = new Uint8Array(RELAY_DEVICE_ID_BYTES)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Create one Ed25519 signing identity plus an X25519 encryption identity
 * through WebCrypto. Keys are SPKI/PKCS8 standard base64, matching
 * `generateDeviceKeyPair`. Missing WebCrypto fails closed.
 */
export async function generateWebCryptoDeviceKeyPair(): Promise<DeviceKeyPair> {
  const subtle = requireSubtle()
  try {
    const signing = await subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])
    const encryption = await subtle.generateKey({ name: 'X25519' }, true, ['deriveBits'])
    if (!hasKeyPair(signing) || !hasKeyPair(encryption)) {
      throw new Error('not a key pair')
    }
    const [
      publicKey,
      privateKey,
      encryptionPublicKey,
      encryptionPrivateKey,
    ] = await Promise.all([
      exportSpki(subtle, signing.publicKey),
      exportPkcs8(subtle, signing.privateKey),
      exportSpki(subtle, encryption.publicKey),
      exportPkcs8(subtle, encryption.privateKey),
    ])
    return {
      publicKey,
      privateKey,
      encryptionPublicKey,
      encryptionPrivateKey,
    }
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('malformed', 'relay device keys require webcrypto')
  }
}

function requireSubtle(): WebCryptoSubtle {
  const crypto = globalThis.crypto
  if (crypto === undefined || crypto.subtle === undefined || typeof crypto.subtle.generateKey !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay device keys require webcrypto')
  }
  return crypto.subtle
}

function hasKeyPair(
  value: unknown,
): value is { readonly publicKey: CryptoKeyLike, readonly privateKey: CryptoKeyLike } {
  return value !== null
    && typeof value === 'object'
    && 'publicKey' in value
    && 'privateKey' in value
}

type CryptoKeyLike = Parameters<WebCryptoSubtle['exportKey']>[1]

async function exportSpki(subtle: WebCryptoSubtle, key: CryptoKeyLike): Promise<string> {
  return bytesToBase64(await subtle.exportKey('spki', key))
}

async function exportPkcs8(subtle: WebCryptoSubtle, key: CryptoKeyLike): Promise<string> {
  return bytesToBase64(await subtle.exportKey('pkcs8', key))
}

function bytesToBase64(buffer: ArrayBuffer): string {
  if (typeof btoa !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay device keys require webcrypto')
  }
  const bytes = new Uint8Array(buffer)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
