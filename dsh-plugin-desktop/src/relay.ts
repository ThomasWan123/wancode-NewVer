/** Cordis Host plugin for opt-in outbound Wan Code relay dials. It never listens. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertOutboundRelayUrl,
  connectOutboundRelay,
  httpUrlFromOutboundRelayUrl,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  registerOutboundRelayDevice,
  RelayAuthorizationError,
  revokeOutboundRelayDevice,
  type RelayApplicationPayload,
} from '@wancode/relay-protocol'
import type { DesktopRelayIdentity } from './relay-identity.ts'

export {
  RELAY_DEVICE_CREDENTIAL_REF,
  loadDesktopRelayIdentity,
  type DesktopRelayHandshakeInput,
  type DesktopRelayIdentity,
  type DesktopRelaySealInput,
  type LoadDesktopRelayIdentityInput,
} from './relay-identity.ts'

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

/** Inputs for outbound HTTP device registration. */
export interface DesktopRelayRegisterInput {
  readonly assertion: unknown
  readonly deviceId: string
  readonly publicKey: string
  readonly encryptionPublicKey?: string
}

/** Inputs for outbound HTTP token mint or revocation. */
export interface DesktopRelayDeviceInput {
  readonly assertion: unknown
  readonly deviceId: string
}

/** Inputs for listing same-account devices over outbound HTTPS. */
export interface DesktopRelayListInput {
  readonly assertion: unknown
}

/** Public device returned by list. Private keys never appear here. */
export interface DesktopRelayPublicDevice {
  readonly deviceId: string
  readonly userId: string
  readonly publicKey: string
  readonly encryptionPublicKey?: string
}

/** Inputs for registering the stored local identity without a socket. */
export interface DesktopRelayEnrollInput {
  readonly assertion: unknown
  readonly identity: Pick<DesktopRelayIdentity, 'deviceId' | 'publicKey' | 'encryptionPublicKey'>
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
  readonly httpUrl: URL
  enroll(input: DesktopRelayEnrollInput): Promise<{
    readonly deviceId: string
    readonly userId: string
    readonly publicKey: string
    readonly encryptionPublicKey?: string
  }>
  register(input: DesktopRelayRegisterInput): Promise<{
    readonly deviceId: string
    readonly userId: string
    readonly publicKey: string
    readonly encryptionPublicKey?: string
  }>
  issueToken(input: DesktopRelayDeviceInput): Promise<{
    readonly accessToken: string
    readonly expiresAt: number
  }>
  revoke(input: DesktopRelayDeviceInput): Promise<{
    readonly deviceId: string
    readonly revokedAt: number
  }>
  listDevices(input: DesktopRelayListInput): Promise<readonly DesktopRelayPublicDevice[]>
  connect(input: DesktopRelayConnectInput): Promise<DesktopRelayConnection>
  dispose(): void
}

export type DesktopRelayConnect = (
  input: DesktopRelayConnectInput & { readonly url: string },
) => Promise<DesktopRelayConnection>

export interface DesktopRelayControl {
  register: typeof registerOutboundRelayDevice
  issueToken: typeof issueOutboundRelayToken
  revoke: typeof revokeOutboundRelayDevice
  listDevices: typeof listOutboundRelayDevices
}

const defaultControl: DesktopRelayControl = {
  register: registerOutboundRelayDevice,
  issueToken: issueOutboundRelayToken,
  revoke: revokeOutboundRelayDevice,
  listDevices: listOutboundRelayDevices,
}

/**
 * Validate an opt-in relay URL without opening a socket.
 * Disabled or empty-URL configs stay idle. Cleartext non-loopback URLs fail closed.
 */
export function prepareDesktopRelay(
  config: Config,
  connect: DesktopRelayConnect = connectOutboundRelay,
  control: DesktopRelayControl = defaultControl,
): DesktopRelayHandle | undefined {
  if (!config.enabled || config.url.length === 0) return undefined
  const url = assertOutboundRelayUrl(config.url)
  const httpUrl = httpUrlFromOutboundRelayUrl(config.url)
  let connection: DesktopRelayConnection | undefined
  return {
    url,
    httpUrl,
    async enroll(input) {
      return control.register({
        httpUrl: httpUrl.href,
        assertion: input.assertion,
        deviceId: input.identity.deviceId,
        publicKey: input.identity.publicKey,
        encryptionPublicKey: input.identity.encryptionPublicKey,
      })
    },
    async register(input) {
      return control.register({
        httpUrl: httpUrl.href,
        assertion: input.assertion,
        deviceId: input.deviceId,
        publicKey: input.publicKey,
        ...(input.encryptionPublicKey === undefined ? {} : { encryptionPublicKey: input.encryptionPublicKey }),
      })
    },
    async issueToken(input) {
      return control.issueToken({
        httpUrl: httpUrl.href,
        assertion: input.assertion,
        deviceId: input.deviceId,
      })
    },
    async revoke(input) {
      return control.revoke({
        httpUrl: httpUrl.href,
        assertion: input.assertion,
        deviceId: input.deviceId,
      })
    },
    async listDevices(input) {
      return control.listDevices({
        httpUrl: httpUrl.href,
        assertion: input.assertion,
      })
    },
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
 * Drain queued and live sealed mail, then open it with the stored identity.
 * Only queued ids are acknowledged. Private keys stay inside `openSealed`.
 */
export async function drainDesktopRelayMail(input: {
  readonly connection: DesktopRelayConnection
  readonly identity: Pick<DesktopRelayIdentity, 'openSealed'>
}): Promise<{
  readonly payloads: readonly RelayApplicationPayload[]
}> {
  const queued = [...await input.connection.reclaim()]
  let live: readonly unknown[] = []
  try {
    live = await input.connection.receive({ timeoutMs: 25 })
  } catch {
    live = []
  }
  const seen = new Set<string>()
  const payloads: RelayApplicationPayload[] = []
  const queuedIds = new Set(queued.map(relayEnvelopeId))
  for (const envelope of [...queued, ...live]) {
    const envelopeId = relayEnvelopeId(envelope)
    if (seen.has(envelopeId)) continue
    seen.add(envelopeId)
    payloads.push(input.identity.openSealed(envelope))
    if (queuedIds.has(envelopeId)) {
      await input.connection.acknowledge({ envelopeId })
    }
  }
  return { payloads }
}

function relayEnvelopeId(envelope: unknown): string {
  if (envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const id = (envelope as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && !/[\0\r\n]/u.test(id)) return id
  }
  throw new RelayAuthorizationError('malformed', 'relay envelope id is required')
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
