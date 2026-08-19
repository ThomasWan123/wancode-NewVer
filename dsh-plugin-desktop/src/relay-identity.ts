/** Desktop relay device identity stored in Windows Credential Manager. */

import { credentialRef } from '@deepseek-ai/dsh-credentials'
import {
  createSignedHandshakeEnvelope,
  createStoredDeviceIdentity,
  parseStoredDeviceIdentity,
  publicDeviceIdentity,
  serializeStoredDeviceIdentity,
} from '@wancode/relay-protocol'
import { credentialTarget, type CredentialStore } from './credentials-win.ts'

/** Opaque Credential Manager reference for the local relay device identity. */
export const RELAY_DEVICE_CREDENTIAL_REF = credentialRef('WANCODE_RELAY_DEVICE')

/** Public identity plus handshake minting. Private keys stay in the store. */
export interface DesktopRelayIdentity {
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey: string
  createHandshake(input: DesktopRelayHandshakeInput): Record<string, unknown>
}

/** Inputs used to mint one outbound handshake from the stored identity. */
export interface DesktopRelayHandshakeInput {
  readonly id: string
  readonly sentAt: number
  readonly userId: string
  readonly nonce: string
  readonly capabilities: readonly string[]
}

/** Inputs for loading or creating the local relay device identity. */
export interface LoadDesktopRelayIdentityInput {
  readonly home: string
  readonly store: CredentialStore
}

/**
 * Load the local relay identity from Credential Manager, generating one if
 * the store is empty. Private keys never appear on the returned object.
 */
export function loadDesktopRelayIdentity(
  input: LoadDesktopRelayIdentityInput,
): DesktopRelayIdentity {
  const target = credentialTarget(input.home, RELAY_DEVICE_CREDENTIAL_REF)
  const existing = input.store.get(target)
  const stored = existing === undefined || existing.length === 0
    ? persistGeneratedIdentity(input.store, target)
    : parseStoredDeviceIdentity(existing)
  const published = publicDeviceIdentity(stored)
  return {
    deviceId: published.deviceId,
    publicKey: published.publicKey,
    encryptionPublicKey: published.encryptionPublicKey,
    createHandshake(handshake) {
      return createSignedHandshakeEnvelope({
        id: handshake.id,
        sentAt: handshake.sentAt,
        actor: { userId: handshake.userId, deviceId: stored.deviceId },
        keyPair: stored.keyPair,
        nonce: handshake.nonce,
        capabilities: [...handshake.capabilities],
      })
    },
  }
}

function persistGeneratedIdentity(store: CredentialStore, target: string) {
  const identity = createStoredDeviceIdentity()
  store.set(target, serializeStoredDeviceIdentity(identity))
  return identity
}
