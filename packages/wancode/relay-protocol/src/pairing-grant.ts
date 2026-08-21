/** One-time pairing grants. The plaintext code is shown once and never stored. */

import { createHash } from 'node:crypto'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayIdentityClaims } from './identity.ts'
import { registerRelayAccountDevice, type RelayDeviceStore } from './devices.ts'
import type { RelayDevice } from './envelope.ts'
import type { RelayTokenIssuer } from './tokens.ts'

/** Ambiguity-free alphabet. Length 8 is 40 bits. */
const PAIRING_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

/** Human-typed pairing code length after hyphens are stripped. */
export const RELAY_PAIRING_CODE_LENGTH = 8

/** Pairing grants expire after five minutes. */
export const RELAY_PAIRING_GRANT_TTL_MS = 5 * 60 * 1000

/** Stored pairing grant. The typed code is hashed; plaintext is never kept. */
export interface RelayPairingGrant {
  readonly grantId: string
  readonly userId: string
  readonly desktopDeviceId: string
  readonly expiresAt: number
  readonly redeemedAt?: number
}

/** Durable pairing-grant lookups. */
export interface RelayPairingGrantStore {
  getPairingGrant(grantId: string): RelayPairingGrant | undefined
  putPairingGrant(grant: RelayPairingGrant): void
  listPairingGrants(): readonly RelayPairingGrant[]
}

/** In-memory grant store for loopback cloud and tests. */
export function createMemoryRelayPairingGrantStore(): RelayPairingGrantStore {
  const grants = new Map<string, RelayPairingGrant>()
  return {
    getPairingGrant(grantId) {
      return grants.get(grantId)
    },
    putPairingGrant(grant) {
      grants.set(grant.grantId, grant)
    },
    listPairingGrants() {
      return [...grants.values()]
    },
  }
}

/** Normalize and refuse JWT-shaped or credential-like pairing codes. */
export function assertRelayPairingCode(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', 'relay pairing code is required')
  }
  if (value.includes('.')) {
    throw new RelayAuthorizationError('malformed', 'relay pairing code must not be a jwt')
  }
  if (/token|secret|credential|password|authorization/iu.test(value)) {
    throw new RelayAuthorizationError('plaintext', 'relay pairing code must not carry credentials')
  }
  const normalized = value.toUpperCase().replace(/[-\s]/gu, '')
  if (normalized.length !== RELAY_PAIRING_CODE_LENGTH) {
    throw new RelayAuthorizationError('malformed', 'relay pairing code is required')
  }
  for (const char of normalized) {
    if (!PAIRING_CODE_ALPHABET.includes(char)) {
      throw new RelayAuthorizationError('malformed', 'relay pairing code is required')
    }
  }
  return normalized
}

/**
 * Mint a pairing code with WebCrypto. Missing WebCrypto fails closed.
 * The returned value is display-formatted; storage hashes the normalized form.
 */
export function createRelayPairingCode(): string {
  const crypto = globalThis.crypto
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') {
    throw new RelayAuthorizationError('malformed', 'relay pairing code requires webcrypto')
  }
  const bytes = new Uint8Array(RELAY_PAIRING_CODE_LENGTH)
  crypto.getRandomValues(bytes)
  let normalized = ''
  for (const byte of bytes) {
    normalized += PAIRING_CODE_ALPHABET[byte % PAIRING_CODE_ALPHABET.length]
  }
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`
}

function hashRelayPairingCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex')
}

/** Inputs for a desktop-minted pairing grant after OIDC verification. */
export interface MintRelayPairingGrantInput {
  readonly identity: RelayIdentityClaims
  readonly desktopDeviceId: string
  readonly now: number
  readonly devices: RelayDeviceStore
  readonly grants: RelayPairingGrantStore
  readonly ttlMs?: number
}

/** Pairing code shown once. The store keeps only the hash. */
export interface MintedRelayPairingGrant {
  readonly pairingCode: string
  readonly expiresAt: number
  readonly desktopDeviceId: string
}

/**
 * Mint a one-time pairing grant for the presented desktop. Outstanding unused
 * grants for that desktop are retired so an old code cannot linger.
 */
export function mintRelayPairingGrant(input: MintRelayPairingGrantInput): MintedRelayPairingGrant {
  if (input.identity.expiresAt <= input.now) {
    throw new RelayAuthorizationError('expired-token', 'relay identity assertion is expired')
  }
  if (typeof input.desktopDeviceId !== 'string' || input.desktopDeviceId.length === 0 || /[\0\r\n]/u.test(input.desktopDeviceId)) {
    throw new RelayAuthorizationError('malformed', 'relay pairing desktop device id is required')
  }
  const ttlMs = input.ttlMs ?? RELAY_PAIRING_GRANT_TTL_MS
  if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) {
    throw new RelayAuthorizationError('expired-token', 'relay pairing grant lifetime must be positive')
  }
  const desktop = input.devices.getDevice(input.desktopDeviceId)
  if (desktop === undefined || (desktop.revokedAt !== undefined && desktop.revokedAt <= input.now)) {
    throw new RelayAuthorizationError('revoked-device', 'relay pairing desktop is unknown or revoked')
  }
  if (desktop.userId !== input.identity.userId) {
    throw new RelayAuthorizationError('cross-account', 'relay pairing desktop does not belong to the presented account')
  }
  for (const grant of input.grants.listPairingGrants()) {
    if (
      grant.desktopDeviceId === input.desktopDeviceId
      && grant.redeemedAt === undefined
      && grant.expiresAt > input.now
    ) {
      input.grants.putPairingGrant({ ...grant, redeemedAt: input.now })
    }
  }
  const pairingCode = createRelayPairingCode()
  const normalized = assertRelayPairingCode(pairingCode)
  const expiresAt = input.now + ttlMs
  input.grants.putPairingGrant({
    grantId: hashRelayPairingCode(normalized),
    userId: input.identity.userId,
    desktopDeviceId: desktop.deviceId,
    expiresAt,
  })
  return { pairingCode, expiresAt, desktopDeviceId: desktop.deviceId }
}

/** Inputs for redeeming a pairing grant into a registered PWA device. */
export interface RedeemRelayPairingGrantInput {
  readonly pairingCode: unknown
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
  readonly now: number
  readonly devices: RelayDeviceStore
  readonly grants: RelayPairingGrantStore
  readonly tokens: RelayTokenIssuer
}

/** Registered PWA plus a short-lived token and the minting desktop. */
export interface RedeemedRelayPairingGrant {
  readonly device: RelayDevice
  readonly desktop: RelayDevice
  readonly accessToken: string
  readonly expiresAt: number
}

/**
 * Redeem a pairing code, register the PWA, and mint a device-bound token.
 * The grant is spent before registration so a retry cannot mint two tokens.
 */
export function redeemRelayPairingGrant(input: RedeemRelayPairingGrantInput): RedeemedRelayPairingGrant {
  const normalized = assertRelayPairingCode(input.pairingCode)
  const grant = input.grants.getPairingGrant(hashRelayPairingCode(normalized))
  if (grant === undefined) {
    throw new RelayAuthorizationError('untrusted-identity', 'relay pairing grant is unknown')
  }
  if (grant.redeemedAt !== undefined && grant.redeemedAt <= input.now) {
    throw new RelayAuthorizationError('replay', 'relay pairing grant was already used')
  }
  if (grant.expiresAt <= input.now) {
    throw new RelayAuthorizationError('expired-token', 'relay pairing grant is expired')
  }
  const desktop = input.devices.getDevice(grant.desktopDeviceId)
  if (desktop === undefined || (desktop.revokedAt !== undefined && desktop.revokedAt <= input.now)) {
    throw new RelayAuthorizationError('revoked-device', 'relay pairing desktop is unknown or revoked')
  }
  if (desktop.userId !== grant.userId) {
    throw new RelayAuthorizationError('cross-account', 'relay pairing desktop does not belong to the presented account')
  }
  if (typeof desktop.encryptionPublicKey !== 'string') {
    throw new RelayAuthorizationError('malformed', 'relay pairing desktop encryption public key is required')
  }
  input.grants.putPairingGrant({ ...grant, redeemedAt: input.now })
  const device = registerRelayAccountDevice({
    userId: grant.userId,
    deviceId: input.deviceId,
    publicKey: input.publicKey,
    encryptionPublicKey: input.encryptionPublicKey,
    now: input.now,
    store: input.devices,
  })
  const issued = input.tokens.issue({
    userId: grant.userId,
    deviceId: device.deviceId,
    now: input.now,
  })
  return {
    device,
    desktop,
    accessToken: issued.accessToken,
    expiresAt: issued.record.expiresAt,
  }
}
