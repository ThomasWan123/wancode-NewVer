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
    close(): void
  }

  export function connectOutboundRelay(
    input: ConnectOutboundRelayInput,
  ): Promise<OutboundRelayConnection>
}
