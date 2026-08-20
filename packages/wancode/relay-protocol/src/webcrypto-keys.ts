/** WebCrypto device keys. This module does not import `node:crypto`. */

import type { DeviceKeyPair } from './device-keys.ts'
import { RelayAuthorizationError } from './errors.ts'

/** Hex device-id length produced by WebCrypto. */
export const RELAY_DEVICE_ID_BYTES = 16

type WebCryptoSubtle = NonNullable<typeof globalThis.crypto>['subtle']
type CryptoKeyLike = Parameters<WebCryptoSubtle['exportKey']>[1]

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

/**
 * Sign canonical UTF-8 bytes with an Ed25519 PKCS8 key through WebCrypto.
 * Missing WebCrypto or an untrusted key fails closed.
 */
export async function signWebCryptoDevicePayload(privateKey: string, payload: Uint8Array): Promise<string> {
  if (typeof privateKey !== 'string' || privateKey.length === 0 || /[\0\r\n]/u.test(privateKey)) {
    throw new RelayAuthorizationError('untrusted-key', 'relay device private key is required')
  }
  const subtle = requireSubtle()
  try {
    const key = await subtle.importKey(
      'pkcs8',
      decodeStandardBase64(privateKey),
      { name: 'Ed25519' },
      false,
      ['sign'],
    )
    return encodeStandardBase64(await subtle.sign({ name: 'Ed25519' }, key, payload))
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('untrusted-key', 'relay device private key is not a valid Ed25519 PKCS8 key')
  }
}

/** Encode bytes as standard base64 without `node:crypto` or `Buffer`. */
export function encodeStandardBase64(bytes: Uint8Array | ArrayBuffer): string {
  if (typeof btoa !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay device keys require webcrypto')
  }
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes
  let binary = ''
  for (const byte of view) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Decode standard base64 without `node:crypto` or `Buffer`. */
export function decodeStandardBase64(value: string): Uint8Array {
  if (typeof atob !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay device keys require webcrypto')
  }
  try {
    const binary = atob(value)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  } catch {
    throw new RelayAuthorizationError('untrusted-key', 'relay device key material is not valid base64')
  }
}

/**
 * Seal plaintext with X25519-HKDF-SHA-256 and AES-256-GCM through WebCrypto.
 * The salt is the envelope id, matching `createSealedRelayEnvelope`.
 */
export async function sealWebCryptoX25519Box(input: {
  readonly senderEncryptionPrivateKey: string
  readonly recipientEncryptionPublicKey: string
  readonly envelopeId: string
  readonly info: string
  readonly aad: Uint8Array
  readonly plaintext: Uint8Array
}): Promise<{ readonly iv: string, readonly tag: string, readonly ciphertext: string }> {
  const crypto = globalThis.crypto
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay sealed box requires webcrypto')
  }
  const subtle = requireSubtle()
  try {
    const privateKey = await subtle.importKey(
      'pkcs8',
      decodeStandardBase64(input.senderEncryptionPrivateKey),
      { name: 'X25519' },
      false,
      ['deriveBits'],
    )
    const publicKey = await subtle.importKey(
      'spki',
      decodeStandardBase64(input.recipientEncryptionPublicKey),
      { name: 'X25519' },
      false,
      [],
    )
    const shared = await subtle.deriveBits({ name: 'X25519', public: publicKey }, privateKey, 256)
    const hkdfKey = await subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits'])
    const keyBytes = await subtle.deriveBits({
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode(input.envelopeId),
      info: new TextEncoder().encode(input.info),
    }, hkdfKey, 256)
    const aesKey = await subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt'])
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = new Uint8Array(await subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: input.aad,
      tagLength: 128,
    }, aesKey, input.plaintext))
    if (sealed.byteLength < 16) {
      throw new Error('short ciphertext')
    }
    return {
      iv: encodeStandardBase64(iv),
      tag: encodeStandardBase64(sealed.slice(sealed.byteLength - 16)),
      ciphertext: encodeStandardBase64(sealed.slice(0, sealed.byteLength - 16)),
    }
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) throw cause
    throw new RelayAuthorizationError('untrusted-key', 'relay sealed box could not be created with webcrypto')
  }
}

function requireSubtle(): WebCryptoSubtle {
  const crypto = globalThis.crypto
  if (
    crypto === undefined
    || crypto.subtle === undefined
    || typeof crypto.subtle.generateKey !== 'function'
    || typeof crypto.subtle.importKey !== 'function'
    || typeof crypto.subtle.sign !== 'function'
    || typeof crypto.subtle.deriveBits !== 'function'
    || typeof crypto.subtle.encrypt !== 'function'
  ) {
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

async function exportSpki(subtle: WebCryptoSubtle, key: CryptoKeyLike): Promise<string> {
  return encodeStandardBase64(await subtle.exportKey('spki', key))
}

async function exportPkcs8(subtle: WebCryptoSubtle, key: CryptoKeyLike): Promise<string> {
  return encodeStandardBase64(await subtle.exportKey('pkcs8', key))
}
