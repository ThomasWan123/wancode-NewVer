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
}
