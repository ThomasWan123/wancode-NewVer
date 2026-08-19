/** Cordis Host plugin for opt-in outbound Wan Code relay dials. It never listens. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertOutboundRelayUrl,
  connectOutboundRelay,
} from '@wancode/relay-protocol'

/** Stable Cordis plugin name. */
export const name = 'desktop-relay'

/** No Host services required; this plugin must stay inert without a relay URL. */
export const inject = []

/** Opt-in outbound relay policy. */
export interface Config {
  /** When false, the plugin never validates a URL or opens a socket. */
  enabled: boolean
  /** Relay WebSocket URL. Empty keeps the plugin idle even when enabled. */
  url: string
}

/** Validated outbound relay policy. Disabled and URL-less by default. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default(''),
})

/** Inputs for one desktop-initiated handshake after the URL has been checked. */
export interface DesktopRelayConnectInput {
  readonly accessToken: string
  readonly envelope: unknown
  readonly timeoutMs?: number
}

/** Live outbound session returned after a successful handshake. */
export interface DesktopRelayConnection {
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

/** Prepared outbound session that still does not dial until `connect` runs. */
export interface DesktopRelayHandle {
  readonly url: URL
  connect(input: DesktopRelayConnectInput): Promise<DesktopRelayConnection>
  dispose(): void
}

export type DesktopRelayConnect = (
  input: DesktopRelayConnectInput & { readonly url: string },
) => Promise<DesktopRelayConnection>

/**
 * Validate an opt-in relay URL without opening a socket.
 * Disabled or empty-URL configs stay idle. Cleartext non-loopback URLs fail closed.
 */
export function prepareDesktopRelay(
  config: Config,
  connect: DesktopRelayConnect = connectOutboundRelay,
): DesktopRelayHandle | undefined {
  if (!config.enabled || config.url.length === 0) return undefined
  const url = assertOutboundRelayUrl(config.url)
  let connection: DesktopRelayConnection | undefined
  return {
    url,
    async connect(input) {
      const next = await connect({ ...input, url: url.href })
      connection?.close()
      connection = next
      return next
    },
    dispose() {
      connection?.close()
      connection = undefined
    },
  }
}

/**
 * Register an effect-scoped outbound relay handle. No listener is created.
 * @param ctx - Host context used only for effect disposal.
 * @param config - validated opt-in relay policy.
 */
export function apply(ctx: Context, config: Config): void {
  const handle = prepareDesktopRelay(config)
  if (handle === undefined) return
  ctx.effect(
    () => () => { handle.dispose() },
    'dsh-plugin-desktop: outbound relay',
  )
}
