/** Ambient types for the bundled Wan Code relay protocol. Yarn cannot link it on exFAT. */

declare module '@wancode/relay-protocol' {
  export class RelayAuthorizationError extends Error {
    readonly code: string
    constructor(code: string, message: string)
  }

  export function assertOutboundRelayUrl(url: string): URL

  export interface ConnectOutboundRelayInput {
    readonly url: string
    readonly accessToken: string
    readonly envelope: unknown
    readonly timeoutMs?: number
  }

  export interface OutboundRelayConnection {
    readonly sessionId: string
    readonly userId: string
    readonly deviceId: string
    readonly grantedCapabilities: readonly string[]
    send(input: {
      readonly envelope: unknown
      readonly destinationDeviceId: string
      readonly timeoutMs?: number
    }): Promise<{
      readonly envelopeId: string
      readonly toDeviceId: string
      readonly outcome: 'delivered' | 'queued' | 'duplicate'
    }>
    reclaim(input?: { readonly timeoutMs?: number }): Promise<readonly unknown[]>
    receive(input?: { readonly timeoutMs?: number }): Promise<readonly unknown[]>
    acknowledge(input: {
      readonly envelopeId: string
      readonly timeoutMs?: number
    }): Promise<{
      readonly envelopeId: string
      readonly toDeviceId: string
      readonly outcome: 'delivered' | 'queued' | 'duplicate'
    }>
    close(): void
  }

  export function connectOutboundRelay(
    input: ConnectOutboundRelayInput,
  ): Promise<OutboundRelayConnection>

  export function assertOutboundRelayHttpUrl(url: string): URL
  export function httpUrlFromOutboundRelayUrl(url: string): URL

  export interface OutboundRelayControlInput {
    readonly httpUrl: string
    readonly assertion: unknown
    readonly deviceId: string
  }

  export interface RegisterOutboundRelayDeviceInput extends OutboundRelayControlInput {
    readonly publicKey: string
    readonly encryptionPublicKey?: string
  }

  export interface OutboundRelayDevice {
    readonly deviceId: string
    readonly userId: string
    readonly publicKey: string
    readonly encryptionPublicKey?: string
  }

  export interface OutboundRelayAccessToken {
    readonly accessToken: string
    readonly expiresAt: number
  }

  export interface OutboundRelayRevocation {
    readonly deviceId: string
    readonly revokedAt: number
  }

  export function registerOutboundRelayDevice(
    input: RegisterOutboundRelayDeviceInput,
  ): Promise<OutboundRelayDevice>
  export function issueOutboundRelayToken(
    input: OutboundRelayControlInput,
  ): Promise<OutboundRelayAccessToken>
  export function revokeOutboundRelayDevice(
    input: OutboundRelayControlInput,
  ): Promise<OutboundRelayRevocation>

  export interface ListOutboundRelayDevicesInput {
    readonly httpUrl: string
    readonly assertion: unknown
  }

  export function listOutboundRelayDevices(
    input: ListOutboundRelayDevicesInput,
  ): Promise<readonly OutboundRelayDevice[]>

  export interface DeviceKeyPair {
    readonly publicKey: string
    readonly privateKey: string
    readonly encryptionPublicKey: string
    readonly encryptionPrivateKey: string
  }

  export interface StoredDeviceIdentity {
    readonly deviceId: string
    readonly keyPair: DeviceKeyPair
  }

  export interface PublicDeviceIdentity {
    readonly deviceId: string
    readonly publicKey: string
    readonly encryptionPublicKey: string
  }

  export function createStoredDeviceIdentity(
    keyPair?: DeviceKeyPair,
    deviceId?: string,
  ): StoredDeviceIdentity
  export function serializeStoredDeviceIdentity(identity: StoredDeviceIdentity): string
  export function parseStoredDeviceIdentity(raw: string): StoredDeviceIdentity
  export function publicDeviceIdentity(identity: StoredDeviceIdentity): PublicDeviceIdentity

  export interface SignedHandshakeEnvelopeInput {
    readonly id: string
    readonly sentAt: number
    readonly actor: { readonly userId: string, readonly deviceId: string }
    readonly keyPair: DeviceKeyPair
    readonly nonce: string
    readonly capabilities: readonly string[]
  }

  export function createSignedHandshakeEnvelope(
    input: SignedHandshakeEnvelopeInput,
  ): Record<string, unknown>

  export type RelayApplicationPayload =
    | { readonly kind: 'prompt', readonly sessionId: string, readonly text: string }
    | { readonly kind: 'approval', readonly sessionId: string, readonly requestId: string, readonly approved: boolean }
    | { readonly kind: 'cancel', readonly sessionId: string, readonly requestId: string }
    | { readonly kind: 'session-event', readonly sessionId: string, readonly type: string, readonly detail: string }
    | { readonly kind: 'presence', readonly state: 'online' | 'offline' }

  export function createSealedRelayEnvelope(input: {
    readonly id: string
    readonly sentAt: number
    readonly actor: { readonly userId: string, readonly deviceId: string }
    readonly kind: string
    readonly sender: DeviceKeyPair
    readonly recipientEncryptionPublicKey: string
    readonly payload: RelayApplicationPayload
  }): Record<string, unknown>

  export function openSealedRelayPayload(
    envelope: unknown,
    recipient: DeviceKeyPair,
  ): RelayApplicationPayload
}
