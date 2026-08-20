/** Device registration and revocation after a verified identity. */

import { assertDeviceEncryptionPublicKey, assertDevicePublicKey } from './device-keys.ts'
import type { RelayDevice, RelayStore } from './envelope.ts'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayIdentityClaims } from './identity.ts'

/** Store that can persist registered devices. */
export type RelayDeviceStore = RelayStore & {
  putDevice(device: RelayDevice): void
  listDevices(): readonly RelayDevice[]
}

/** Inputs for binding one device public key to a verified account. */
export interface RegisterRelayDeviceInput {
  readonly identity: RelayIdentityClaims
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey?: string
  readonly now: number
  readonly store: RelayDeviceStore
}

/** Inputs for immediately revoking one owned device. */
export interface RevokeRelayDeviceInput {
  readonly userId: string
  readonly deviceId: string
  readonly now: number
  readonly store: RelayDeviceStore
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || /[\0\r\n]/u.test(value)) {
    throw new RelayAuthorizationError('malformed', `relay ${field} is required`)
  }
  return value
}

/**
 * Register a desktop or PWA device for a verified identity.
 * A revoked device id cannot be reused. A live device cannot change accounts.
 */
export function registerRelayDevice(input: RegisterRelayDeviceInput): RelayDevice {
  if (input.identity.expiresAt <= input.now) {
    throw new RelayAuthorizationError('expired-token', 'relay identity assertion is expired')
  }
  const deviceId = requiredId(input.deviceId, 'deviceId')
  const userId = requiredId(input.identity.userId, 'userId')
  assertDevicePublicKey(input.publicKey)
  const encryptionPublicKey = input.encryptionPublicKey
  if (encryptionPublicKey !== undefined) {
    assertDeviceEncryptionPublicKey(encryptionPublicKey)
  }
  const existing = input.store.getDevice(deviceId)
  if (existing !== undefined) {
    if (existing.userId !== userId) {
      throw new RelayAuthorizationError('cross-account', 'relay device already belongs to another account')
    }
    if (existing.revokedAt !== undefined && existing.revokedAt <= input.now) {
      throw new RelayAuthorizationError('revoked-device', 'relay device id was revoked and cannot be reused')
    }
    if (existing.publicKey !== input.publicKey) {
      throw new RelayAuthorizationError('untrusted-key', 'relay device public key does not match the registered key')
    }
    if (
      encryptionPublicKey !== undefined &&
      existing.encryptionPublicKey !== undefined &&
      existing.encryptionPublicKey !== encryptionPublicKey
    ) {
      throw new RelayAuthorizationError('untrusted-key', 'relay device encryption public key does not match the registered key')
    }
    return existing
  }
  const device: RelayDevice = encryptionPublicKey === undefined
    ? { deviceId, userId, publicKey: input.publicKey }
    : { deviceId, userId, publicKey: input.publicKey, encryptionPublicKey }
  input.store.putDevice(device)
  return device
}

/**
 * List live devices for one account. Revoked rows are omitted. Device records
 * never carry private keys. Rows whose signing or encryption keys are not
 * Ed25519 or X25519 are omitted so a poisoned store cannot fail the whole list.
 */
export function listRelayAccountDevices(input: {
  readonly userId: string
  readonly now: number
  readonly store: RelayDeviceStore
}): readonly RelayDevice[] {
  const userId = requiredId(input.userId, 'userId')
  return input.store.listDevices().filter(device => (
    device.userId === userId
    && (device.revokedAt === undefined || device.revokedAt > input.now)
    && hasTrustedListedKeys(device)
  ))
}

function hasTrustedListedKeys(device: RelayDevice): boolean {
  try {
    assertDevicePublicKey(device.publicKey)
    if (device.encryptionPublicKey !== undefined) {
      assertDeviceEncryptionPublicKey(device.encryptionPublicKey)
    }
    return true
  } catch (cause) {
    if (cause instanceof RelayAuthorizationError) return false
    throw cause
  }
}

/**
 * Revoke one owned device immediately. Repeat revokes of the same device stay idempotent.
 */
export function revokeRelayDevice(input: RevokeRelayDeviceInput): RelayDevice {
  const deviceId = requiredId(input.deviceId, 'deviceId')
  const userId = requiredId(input.userId, 'userId')
  const existing = input.store.getDevice(deviceId)
  if (existing === undefined) {
    throw new RelayAuthorizationError('revoked-device', 'relay device is unknown or revoked')
  }
  if (existing.userId !== userId) {
    throw new RelayAuthorizationError('cross-account', 'relay device already belongs to another account')
  }
  if (existing.revokedAt !== undefined && existing.revokedAt <= input.now) {
    return existing
  }
  const device: RelayDevice = {
    ...existing,
    revokedAt: input.now,
  }
  input.store.putDevice(device)
  return device
}
