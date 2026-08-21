/** Cordis Host plugin for opt-in outbound Wan Code relay dials. It never listens. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  assertNoPlaintextRelayFields,
  assertOutboundRelayUrl,
  assertRelayPairingCode,
  connectOutboundRelay,
  createRelayHandshakeNonce,
  enrollOutboundRelayLoopbackDevice,
  httpUrlFromOutboundRelayUrl,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  mintOutboundRelayPairingGrant,
  registerOutboundRelayDevice,
  RelayAuthorizationError,
  revokeOutboundRelayDevice,
  type RelayApplicationPayload,
} from '@wancode/relay-protocol'
import { loadDesktopRelayIdentity, type DesktopRelayHandshakeInput, type DesktopRelayIdentity } from './relay-identity.ts'
import { createWindowsCredentialStore } from './credentials-win.ts'
import type { DesktopTrayItem, DesktopTrayItemRegistration } from './runtime.ts'

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

/** Session id that starts a new Host conversation instead of targeting a live one. */
export const DESKTOP_RELAY_QUEUE_SESSION_ID = 'queue'

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
  readonly encryptionPublicKey: string
}

/** Inputs for outbound HTTP token mint or revocation. */
export interface DesktopRelayDeviceInput {
  readonly assertion: unknown
  readonly deviceId: string
}

/** Inputs for minting a one-time pairing grant. After connect, the session token may replace the assertion. */
export interface DesktopRelayPairingGrantInput {
  readonly deviceId: string
  readonly assertion?: unknown
  readonly accessToken?: string
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
  mintPairingGrant(input: DesktopRelayPairingGrantInput): Promise<{
    readonly pairingCode: string
    readonly expiresAt: number
    readonly desktopDeviceId: string
  }>
  readonly connectedDeviceId?: string
  connect(input: DesktopRelayConnectInput): Promise<DesktopRelayConnection>
  processMail(input: Pick<ProcessDesktopRelayMailInput, 'identity'> & Partial<DesktopRelayApplySinks>): Promise<{
    readonly applied: number
    readonly ignored: number
  }>
  sendProgress(input: SealDesktopRelaySessionEventInput & {
    readonly destinationDeviceId: string
  }): Promise<{
    readonly envelopeId: string
    readonly toDeviceId: string
    readonly outcome: 'delivered' | 'queued' | 'duplicate'
  }>
  sendPresence(input: SealDesktopRelayPresenceInput & {
    readonly destinationDeviceId: string
  }): Promise<{
    readonly envelopeId: string
    readonly toDeviceId: string
    readonly outcome: 'delivered' | 'queued' | 'duplicate'
  }>
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
  mintPairingGrant?: typeof mintOutboundRelayPairingGrant
}

const defaultControl: DesktopRelayControl = {
  register: registerOutboundRelayDevice,
  issueToken: issueOutboundRelayToken,
  revoke: revokeOutboundRelayDevice,
  listDevices: listOutboundRelayDevices,
  mintPairingGrant: mintOutboundRelayPairingGrant,
}

/**
 * Validate an opt-in relay URL without opening a socket.
 * Disabled or empty-URL configs stay idle. Cleartext non-loopback URLs fail closed.
 */
export function prepareDesktopRelay(
  config: Config,
  connect: DesktopRelayConnect = connectOutboundRelay,
  control: DesktopRelayControl = defaultControl,
  applySinks?: Required<DesktopRelayApplySinks>,
  host?: { readonly get: (name: string) => unknown },
): DesktopRelayHandle | undefined {
  if (!config.enabled || config.url.length === 0) return undefined
  const url = assertOutboundRelayUrl(config.url)
  const httpUrl = httpUrlFromOutboundRelayUrl(config.url)
  let connection: DesktopRelayConnection | undefined
  let sessionToken: string | undefined
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
        encryptionPublicKey: input.encryptionPublicKey,
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
    async mintPairingGrant(input) {
      const mint = control.mintPairingGrant
      if (mint === undefined) {
        throw new RelayAuthorizationError('malformed', 'desktop relay pairing grant is required')
      }
      const assertion = input.assertion
      const accessToken = typeof input.accessToken === 'string' && input.accessToken.length > 0
        ? input.accessToken
        : assertion === undefined ? sessionToken : undefined
      if (assertion !== undefined && typeof accessToken === 'string') {
        throw new RelayAuthorizationError('malformed', 'desktop relay pairing grant requires an assertion or access token')
      }
      if (assertion === undefined) {
        if (typeof accessToken !== 'string' || accessToken.length === 0) {
          throw new RelayAuthorizationError('malformed', 'desktop relay pairing grant requires an assertion or access token')
        }
        return mint({
          httpUrl: httpUrl.href,
          deviceId: input.deviceId,
          accessToken,
        })
      }
      return mint({
        httpUrl: httpUrl.href,
        assertion,
        deviceId: input.deviceId,
      })
    },
    async connect(input) {
      const next = await connect({ ...input, url: url.href })
      connection?.close()
      connection = next
      sessionToken = input.accessToken
      return next
    },
    async processMail(input) {
      if (connection === undefined) {
        throw new RelayAuthorizationError('malformed', 'desktop relay is not connected')
      }
      return processDesktopRelayMail({
        connection,
        identity: input.identity,
        ...mergeDesktopRelayApplySinks(
          input,
          (host === undefined ? undefined : lookupDesktopRelayHostApplySinks(host)) ?? applySinks,
        ),
      })
    },
    async sendProgress(input) {
      if (connection === undefined) {
        throw new RelayAuthorizationError('malformed', 'desktop relay is not connected')
      }
      return sendDesktopRelaySessionEvent({ connection, ...input })
    },
    async sendPresence(input) {
      if (connection === undefined) {
        throw new RelayAuthorizationError('malformed', 'desktop relay is not connected')
      }
      return sendDesktopRelayPresence({ connection, ...input })
    },
    get connectedDeviceId() {
      return connection?.deviceId
    },
    dispose() {
      connection?.close()
      connection = undefined
      sessionToken = undefined
    },
  }
}

/**
 * Enroll the stored desktop identity, mint a token, and dial. Private keys
 * stay inside `createHandshake`. This still does not listen.
 */
export async function openDesktopRelaySession(input: {
  readonly handle: DesktopRelayHandle
  readonly identity: Pick<DesktopRelayIdentity, 'deviceId' | 'publicKey' | 'encryptionPublicKey'> & {
    createHandshake(input: DesktopRelayHandshakeInput): Record<string, unknown>
  }
  readonly assertion: unknown
  readonly userId: string
  readonly nonce?: string
  readonly now?: number
}): Promise<DesktopRelayConnection> {
  if (typeof input.userId !== 'string' || input.userId.length === 0 || /[\0\r\n]/u.test(input.userId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay user id is required')
  }
  const nonce = input.nonce ?? createRelayHandshakeNonce()
  if (typeof nonce !== 'string' || nonce.length === 0 || /[\0\r\n]/u.test(nonce)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay handshake nonce is required')
  }
  await input.handle.enroll({
    assertion: input.assertion,
    identity: input.identity,
  })
  const token = await input.handle.issueToken({
    assertion: input.assertion,
    deviceId: input.identity.deviceId,
  })
  return input.handle.connect({
    accessToken: token.accessToken,
    envelope: input.identity.createHandshake({
      id: `hs:${input.identity.deviceId}:${nonce}`,
      sentAt: input.now ?? Date.now(),
      userId: input.userId,
      nonce,
      capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
    }),
  })
}

const LOOPBACK_RELAY_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/**
 * Enroll on loopback without OIDC, then dial. Public hosts fail closed.
 * Private keys stay inside `createHandshake`. This still does not listen.
 */
export async function openDesktopRelayLoopbackSession(input: {
  readonly handle: DesktopRelayHandle
  readonly identity: Pick<DesktopRelayIdentity, 'deviceId' | 'publicKey' | 'encryptionPublicKey'> & {
    createHandshake(input: DesktopRelayHandshakeInput): Record<string, unknown>
  }
  readonly nonce?: string
  readonly now?: number
  readonly enroll?: typeof enrollOutboundRelayLoopbackDevice
}): Promise<DesktopRelayConnection> {
  if (!LOOPBACK_RELAY_HOSTS.has(input.handle.httpUrl.hostname)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay loopback enroll is only allowed to loopback')
  }
  const nonce = input.nonce ?? createRelayHandshakeNonce()
  if (typeof nonce !== 'string' || nonce.length === 0 || /[\0\r\n]/u.test(nonce)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay handshake nonce is required')
  }
  const enroll = input.enroll ?? enrollOutboundRelayLoopbackDevice
  const enrolled = await enroll({
    httpUrl: input.handle.httpUrl.href,
    deviceId: input.identity.deviceId,
    publicKey: input.identity.publicKey,
    encryptionPublicKey: input.identity.encryptionPublicKey,
  })
  return input.handle.connect({
    accessToken: enrolled.accessToken,
    envelope: input.identity.createHandshake({
      id: `hs:${input.identity.deviceId}:${nonce}`,
      sentAt: input.now ?? Date.now(),
      userId: enrolled.device.userId,
      nonce,
      capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
    }),
  })
}

/**
 * Open an outbound session then apply queued PWA mail. Model credentials stay
 * on the desktop. This still does not listen.
 */
export async function openDesktopRelayMailbox(input: {
  readonly handle: DesktopRelayHandle
  readonly identity: Pick<DesktopRelayIdentity, 'deviceId' | 'publicKey' | 'encryptionPublicKey' | 'openSealed'> & {
    createHandshake(input: DesktopRelayHandshakeInput): Record<string, unknown>
  }
  readonly assertion: unknown
  readonly userId: string
  readonly nonce?: string
  readonly now?: number
}): Promise<{ readonly applied: number, readonly ignored: number }> {
  await openDesktopRelaySession(input)
  return input.handle.processMail({ identity: input.identity })
}

/** Same 8192-character follow-up cap as the PWA sender. */
export const MAX_DESKTOP_RELAY_FOLLOW_UP_CHARS = 8_192

/** Compact progress detail for low-bandwidth PWA links. */
export const MAX_DESKTOP_RELAY_PROGRESS_DETAIL_CHARS = 512

const DESKTOP_RELAY_PROGRESS_TYPES = new Set([
  'notify.tool',
  'notify.approval',
  'assistant.delta',
  'assistant.done',
  'session.complete',
  'tool.progress',
])

/** Inputs used to seal one desktop progress event to a PWA. */
export interface SealDesktopRelaySessionEventInput {
  readonly identity: Pick<DesktopRelayIdentity, 'sealTo'>
  readonly id: string
  readonly sentAt: number
  readonly userId: string
  readonly recipientEncryptionPublicKey: string
  readonly sessionId: string
  readonly type: string
  readonly detail: string
}

/**
 * Seal a UI-neutral progress event to a PWA. Prompt text, unknown types, and
 * oversized details fail closed so model credentials stay on the desktop.
 */
export function sealDesktopRelaySessionEvent(
  input: SealDesktopRelaySessionEventInput,
): Record<string, unknown> {
  const payload: RelayApplicationPayload = {
    kind: 'session-event',
    sessionId: input.sessionId,
    type: input.type,
    detail: input.detail,
  }
  assertNoPlaintextRelayFields(payload as unknown as Record<string, unknown>, 'desktop relay progress')
  if (input.sessionId.length === 0 || /[\0\r\n]/u.test(input.sessionId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay progress session id is required')
  }
  if (!DESKTOP_RELAY_PROGRESS_TYPES.has(input.type)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay progress type is not supported')
  }
  if (input.detail.length === 0 || /[\0\r\n]/u.test(input.detail)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay progress detail is required')
  }
  if (input.detail.length > MAX_DESKTOP_RELAY_PROGRESS_DETAIL_CHARS) {
    throw new RelayAuthorizationError('malformed', 'desktop relay progress detail is too large')
  }
  assertDesktopRelayRecipient(input.recipientEncryptionPublicKey)
  return input.identity.sealTo({
    id: input.id,
    sentAt: input.sentAt,
    userId: input.userId,
    recipientEncryptionPublicKey: input.recipientEncryptionPublicKey,
    payload,
  })
}

/**
 * Send one sealed progress event to a PWA over the outbound socket. This never
 * listens and never includes prompt text.
 */
export async function sendDesktopRelaySessionEvent(input: SealDesktopRelaySessionEventInput & {
  readonly connection: DesktopRelayConnection
  readonly destinationDeviceId: string
}): Promise<{
  readonly envelopeId: string
  readonly toDeviceId: string
  readonly outcome: 'delivered' | 'queued' | 'duplicate'
}> {
  if (input.destinationDeviceId.length === 0 || /[\0\r\n]/u.test(input.destinationDeviceId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay progress destination is required')
  }
  return input.connection.send({
    envelope: sealDesktopRelaySessionEvent(input),
    destinationDeviceId: input.destinationDeviceId,
  })
}

/** Inputs used to seal desktop presence to a PWA. Prompt text never appears. */
export interface SealDesktopRelayPresenceInput {
  readonly identity: Pick<DesktopRelayIdentity, 'sealTo'>
  readonly id: string
  readonly sentAt: number
  readonly userId: string
  readonly recipientEncryptionPublicKey: string
  readonly state: 'online' | 'offline'
}

/**
 * Seal a presence frame to a PWA. Unknown states fail closed.
 */
export function sealDesktopRelayPresence(
  input: SealDesktopRelayPresenceInput,
): Record<string, unknown> {
  if (input.state !== 'online' && input.state !== 'offline') {
    throw new RelayAuthorizationError('malformed', 'desktop relay presence state is invalid')
  }
  assertDesktopRelayRecipient(input.recipientEncryptionPublicKey)
  const payload: RelayApplicationPayload = { kind: 'presence', state: input.state }
  assertNoPlaintextRelayFields(payload as unknown as Record<string, unknown>, 'desktop relay presence')
  return input.identity.sealTo({
    id: input.id,
    sentAt: input.sentAt,
    userId: input.userId,
    recipientEncryptionPublicKey: input.recipientEncryptionPublicKey,
    payload,
  })
}

/**
 * Send one sealed presence frame to a PWA over the outbound socket.
 */
export async function sendDesktopRelayPresence(input: SealDesktopRelayPresenceInput & {
  readonly connection: DesktopRelayConnection
  readonly destinationDeviceId: string
}): Promise<{
  readonly envelopeId: string
  readonly toDeviceId: string
  readonly outcome: 'delivered' | 'queued' | 'duplicate'
}> {
  if (input.destinationDeviceId.length === 0 || /[\0\r\n]/u.test(input.destinationDeviceId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay presence destination is required')
  }
  return input.connection.send({
    envelope: sealDesktopRelayPresence(input),
    destinationDeviceId: input.destinationDeviceId,
  })
}

/** Sinks used to apply opened PWA mail without exposing model credentials. */
export interface DesktopRelayApplySinks {
  readonly followUp: (input: {
    readonly sessionId: string
    readonly text: string
  }) => Promise<void>
  readonly approval?: (input: {
    readonly sessionId: string
    readonly requestId: string
    readonly approved: boolean
  }) => Promise<void>
  readonly cancel?: (input: {
    readonly sessionId: string
    readonly requestId: string
  }) => Promise<void>
}

/** Drain, apply, then ack. Identity and sinks stay on the desktop. */
export interface ProcessDesktopRelayMailInput extends DesktopRelayApplySinks {
  readonly identity: Pick<DesktopRelayIdentity, 'openSealed'>
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
  const payloads: RelayApplicationPayload[] = []
  for (const item of await collectDesktopRelayMail(input.connection)) {
    payloads.push(input.identity.openSealed(item.envelope))
    if (item.queued) {
      await input.connection.acknowledge({ envelopeId: item.envelopeId })
    }
  }
  return { payloads }
}

/**
 * Open sealed PWA mail, apply it locally, then ack only queued ids that
 * applied or were ignored. A refused follow-up is not acknowledged so it can
 * be retried. Model credentials stay on the desktop.
 */
export async function processDesktopRelayMail(input: {
  readonly connection: DesktopRelayConnection
} & ProcessDesktopRelayMailInput): Promise<{
  readonly applied: number
  readonly ignored: number
}> {
  let applied = 0
  let ignored = 0
  for (const item of await collectDesktopRelayMail(input.connection)) {
    const payload = input.identity.openSealed(item.envelope)
    const result = await applyDesktopRelayPayloads({
      payloads: [payload],
      followUp: input.followUp,
      ...(input.approval === undefined ? {} : { approval: input.approval }),
      ...(input.cancel === undefined ? {} : { cancel: input.cancel }),
    })
    applied += result.applied
    ignored += result.ignored
    if (item.queued) {
      await input.connection.acknowledge({ envelopeId: item.envelopeId })
    }
  }
  return { applied, ignored }
}

/**
 * Apply opened PWA payloads on the desktop. Prompt text is handed to the
 * caller-supplied follow-up sink so model credentials stay local. Session
 * events and presence are ignored; they travel desktop to PWA, not back.
 */
export async function applyDesktopRelayPayloads(input: {
  readonly payloads: readonly RelayApplicationPayload[]
} & DesktopRelayApplySinks): Promise<{
  readonly applied: number
  readonly ignored: number
}> {
  let applied = 0
  let ignored = 0
  for (const payload of input.payloads) {
    switch (payload.kind) {
      case 'prompt':
        assertDesktopRelayFollowUp(payload)
        await input.followUp({ sessionId: payload.sessionId, text: payload.text })
        applied += 1
        break
      case 'approval':
        if (input.approval === undefined) {
          throw new RelayAuthorizationError('malformed', 'desktop relay approval sink is required')
        }
        assertDesktopRelayControl(payload)
        await input.approval({
          sessionId: payload.sessionId,
          requestId: payload.requestId,
          approved: payload.approved,
        })
        applied += 1
        break
      case 'cancel':
        if (input.cancel === undefined) {
          throw new RelayAuthorizationError('malformed', 'desktop relay cancel sink is required')
        }
        assertDesktopRelayControl(payload)
        await input.cancel({
          sessionId: payload.sessionId,
          requestId: payload.requestId,
        })
        applied += 1
        break
      case 'session-event':
      case 'presence':
        ignored += 1
        break
      default: {
        const exhaustive: never = payload
        throw new RelayAuthorizationError('malformed', `desktop relay payload kind is not supported: ${String(exhaustive)}`)
      }
    }
  }
  return { applied, ignored }
}

async function collectDesktopRelayMail(connection: DesktopRelayConnection): Promise<readonly {
  readonly envelope: unknown
  readonly envelopeId: string
  readonly queued: boolean
}[]> {
  const queued = [...await connection.reclaim()]
  let live: readonly unknown[] = []
  try {
    live = await connection.receive({ timeoutMs: 25 })
  } catch {
    live = []
  }
  const queuedIds = new Set(queued.map(relayEnvelopeId))
  const seen = new Set<string>()
  const collected: {
    readonly envelope: unknown
    readonly envelopeId: string
    readonly queued: boolean
  }[] = []
  for (const envelope of [...queued, ...live]) {
    const envelopeId = relayEnvelopeId(envelope)
    if (seen.has(envelopeId)) continue
    seen.add(envelopeId)
    collected.push({ envelope, envelopeId, queued: queuedIds.has(envelopeId) })
  }
  return collected
}

function assertDesktopRelayFollowUp(payload: Extract<RelayApplicationPayload, { kind: 'prompt' }>): void {
  if (payload.sessionId.length === 0 || /[\0\r\n]/u.test(payload.sessionId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay follow-up session id is required')
  }
  if (payload.text.length === 0) {
    throw new RelayAuthorizationError('malformed', 'desktop relay follow-up text is required')
  }
  if (payload.text.length > MAX_DESKTOP_RELAY_FOLLOW_UP_CHARS) {
    throw new RelayAuthorizationError('malformed', 'desktop relay follow-up text is too large')
  }
}

function assertDesktopRelayControl(payload: Extract<RelayApplicationPayload, { kind: 'approval' | 'cancel' }>): void {
  if (payload.sessionId.length === 0 || /[\0\r\n]/u.test(payload.sessionId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay control session id is required')
  }
  if (payload.requestId.length === 0 || /[\0\r\n]/u.test(payload.requestId)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay control request id is required')
  }
}

function assertDesktopRelayRecipient(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || /[\0\r\n]/u.test(key)) {
    throw new RelayAuthorizationError('malformed', 'desktop relay recipient encryption key is required')
  }
}

/**
 * Bind follow-ups to a live desktop session lookup. Missing sessions fail
 * closed so prompt text is not applied to the wrong Host session.
 */
export function createDesktopRelayFollowUpSink(input: {
  readonly getSession: (sessionId: string) => {
    readonly submit: (text: string) => Promise<void>
  } | undefined
}): DesktopRelayApplySinks['followUp'] {
  return async (followUp) => {
    const session = input.getSession(followUp.sessionId)
    if (session === undefined) {
      throw new RelayAuthorizationError('malformed', 'desktop relay follow-up session is required')
    }
    await session.submit(followUp.text)
  }
}

/**
 * Bind approvals to a live desktop request lookup. Missing requests fail
 * closed so a PWA cannot approve the wrong tool call.
 */
export function createDesktopRelayApprovalSink(input: {
  readonly getRequest: (input: {
    readonly sessionId: string
    readonly requestId: string
  }) => {
    readonly decide: (approved: boolean) => Promise<void>
  } | undefined
}): NonNullable<DesktopRelayApplySinks['approval']> {
  return async (approval) => {
    const request = input.getRequest({
      sessionId: approval.sessionId,
      requestId: approval.requestId,
    })
    if (request === undefined) {
      throw new RelayAuthorizationError('malformed', 'desktop relay approval request is required')
    }
    await request.decide(approval.approved)
  }
}

/**
 * Bind cancels to a live desktop request lookup. Missing requests fail closed
 * so a PWA cannot cancel the wrong tool call.
 */
export function createDesktopRelayCancelSink(input: {
  readonly getRequest: (input: {
    readonly sessionId: string
    readonly requestId: string
  }) => {
    readonly cancel: () => Promise<void>
  } | undefined
}): NonNullable<DesktopRelayApplySinks['cancel']> {
  return async (cancel) => {
    const request = input.getRequest({
      sessionId: cancel.sessionId,
      requestId: cancel.requestId,
    })
    if (request === undefined) {
      throw new RelayAuthorizationError('malformed', 'desktop relay cancel request is required')
    }
    await request.cancel()
  }
}

/**
 * Bind follow-up, approval, and cancel to live desktop lookups. Missing
 * sessions or request ids fail closed so PWA mail cannot hit the wrong Host
 * session. This does not listen and does not inject Host services.
 */
export function createDesktopRelayApplySinks(input: {
  readonly getSession: (sessionId: string) => {
    readonly submit: (text: string) => Promise<void>
  } | undefined
  readonly getRequest: (input: {
    readonly sessionId: string
    readonly requestId: string
  }) => {
    readonly decide: (approved: boolean) => Promise<void>
    readonly cancel: () => Promise<void>
  } | undefined
}): Required<DesktopRelayApplySinks> {
  return {
    followUp: createDesktopRelayFollowUpSink({ getSession: input.getSession }),
    approval: createDesktopRelayApprovalSink({
      getRequest: request => {
        const found = input.getRequest(request)
        return found === undefined ? undefined : { decide: found.decide }
      },
    }),
    cancel: createDesktopRelayCancelSink({
      getRequest: request => {
        const found = input.getRequest(request)
        return found === undefined ? undefined : { cancel: found.cancel }
      },
    }),
  }
}

/**
 * Host/client session shape used to queue a follow-up. This is not a Cordis
 * inject and does not listen.
 */
export interface DesktopRelayHostSession {
  readonly prompt: (
    parts: readonly { readonly type: 'text'; readonly text: string }[],
    mode: 'queue',
  ) => Promise<unknown>
}

/**
 * Queue a follow-up through Host `prompt([{ type: 'text', text }], 'queue')`
 * so PWA mail uses the same submit path as the desktop Client. Missing
 * sessions still fail closed. This does not inject Host services.
 */
export function createDesktopRelayHostFollowUpSink(input: {
  readonly getSession: (sessionId: string) => DesktopRelayHostSession | undefined
}): DesktopRelayApplySinks['followUp'] {
  return createDesktopRelayFollowUpSink({
    getSession: sessionId => {
      const session = input.getSession(sessionId)
      return session === undefined ? undefined : bindDesktopRelayHostSession(session)
    },
  })
}

/**
 * Host/client approval shape used to answer a pending tool request. Client
 * answers are `allowed-once` or `rejected`. This is not a Cordis inject.
 */
export interface DesktopRelayHostApprovalRequest {
  readonly respond: (outcome: 'allowed-once' | 'rejected') => Promise<unknown>
  readonly cancel: () => Promise<unknown>
}

/**
 * Bind follow-up, approval, and cancel to live Host lookups. Follow-ups use
 * `prompt(..., 'queue')`. Approvals map to Host `respond('allowed-once' |
 * 'rejected')`. Missing sessions or request ids fail closed. This does not
 * listen and does not inject Host services.
 */
export function createDesktopRelayHostApplySinks(input: {
  readonly getSession: (sessionId: string) => DesktopRelayHostSession | undefined
  readonly getRequest: (input: {
    readonly sessionId: string
    readonly requestId: string
  }) => DesktopRelayHostApprovalRequest | undefined
}): Required<DesktopRelayApplySinks> {
  return createDesktopRelayApplySinks({
    getSession: sessionId => {
      const session = input.getSession(sessionId)
      return session === undefined ? undefined : bindDesktopRelayHostSession(session)
    },
    getRequest: request => {
      const found = input.getRequest(request)
      return found === undefined ? undefined : bindDesktopRelayHostApprovalRequest(found)
    },
  })
}

function bindDesktopRelayHostSession(session: DesktopRelayHostSession): {
  readonly submit: (text: string) => Promise<void>
} {
  return {
    async submit(text) {
      await session.prompt([{ type: 'text', text }], 'queue')
    },
  }
}

function bindDesktopRelayHostApprovalRequest(request: DesktopRelayHostApprovalRequest): {
  readonly decide: (approved: boolean) => Promise<void>
  readonly cancel: () => Promise<void>
} {
  return {
    async decide(approved) {
      await request.respond(approved ? 'allowed-once' : 'rejected')
    },
    async cancel() {
      await request.cancel()
    },
  }
}

function mergeDesktopRelayApplySinks(
  input: Partial<DesktopRelayApplySinks>,
  defaults: Required<DesktopRelayApplySinks> | undefined,
): DesktopRelayApplySinks {
  const followUp = input.followUp ?? defaults?.followUp
  if (followUp === undefined) {
    throw new RelayAuthorizationError('malformed', 'desktop relay follow-up sink is required')
  }
  const approval = input.approval ?? defaults?.approval
  const cancel = input.cancel ?? defaults?.cancel
  return {
    followUp,
    ...(approval === undefined ? {} : { approval }),
    ...(cancel === undefined ? {} : { cancel }),
  }
}

function relayEnvelopeId(envelope: unknown): string {
  if (envelope !== null && typeof envelope === 'object' && !Array.isArray(envelope)) {
    const id = (envelope as { id?: unknown }).id
    if (typeof id === 'string' && id.length > 0 && !/[\0\r\n]/u.test(id)) return id
  }
  throw new RelayAuthorizationError('malformed', 'relay envelope id is required')
}

/**
 * Probe optional Host services for PWA mail sinks. Host `prompt` / `respond`
 * and Client `submit` / `decide` shapes are both accepted. Session id `queue`
 * creates a new Host session when `sessions.create` exists. Missing sessions
 * return undefined so the plugin stays idle without injecting Host services.
 */
export function lookupDesktopRelayHostApplySinks(ctx: {
  readonly get: (name: string) => unknown
}): Required<DesktopRelayApplySinks> | undefined {
  const sessions = ctx.get('sessions')
  if (!hasGet(sessions)) return undefined
  const approvals = ctx.get('approvals')
  return createDesktopRelayHostApplySinks({
    getSession: sessionId => asHostSession(
      sessionId === DESKTOP_RELAY_QUEUE_SESSION_ID
        ? createQueuedHostSession(sessions)
        : sessions.get(sessionId),
    ),
    getRequest: request => asHostApprovalRequest(approvals, request),
  })
}

function createQueuedHostSession(sessions: { get: (id: string) => unknown }): unknown {
  const create = (sessions as { create?: unknown }).create
  if (typeof create !== 'function') return undefined
  return create.call(sessions)
}

function hasGet(value: unknown): value is { get: (id: string) => unknown } {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
}

function asHostSession(value: unknown): DesktopRelayHostSession | undefined {
  if (value === null || typeof value !== 'object') return undefined
  if (typeof (value as { prompt?: unknown }).prompt === 'function') {
    return value as DesktopRelayHostSession
  }
  const submit = (value as { submit?: unknown }).submit
  if (typeof submit !== 'function') return undefined
  return {
    async prompt(parts, mode) {
      if (mode !== 'queue') {
        throw new RelayAuthorizationError('malformed', 'desktop relay follow-up queue mode is required')
      }
      if (parts.length !== 1 || parts[0]?.type !== 'text' || typeof parts[0].text !== 'string') {
        throw new RelayAuthorizationError('malformed', 'desktop relay follow-up text is required')
      }
      await (submit as (text: string) => Promise<unknown>).call(value, parts[0].text)
    },
  }
}

function asHostApprovalRequest(
  store: unknown,
  request: { readonly sessionId: string, readonly requestId: string },
): DesktopRelayHostApprovalRequest | undefined {
  if (store === null || typeof store !== 'object') return undefined
  const get = (store as { get?: unknown }).get
  if (typeof get !== 'function') return undefined
  const record = (get as (input: {
    readonly sessionId: string
    readonly requestId: string
  }) => unknown).call(store, request)
  if (record === null || typeof record !== 'object') return undefined
  const cancel = (record as { cancel?: unknown }).cancel
  if (typeof cancel !== 'function') return undefined
  if (typeof (record as { respond?: unknown }).respond === 'function') {
    return record as DesktopRelayHostApprovalRequest
  }
  const decide = (record as { decide?: unknown }).decide
  if (typeof decide !== 'function') return undefined
  return {
    async respond(outcome) {
      await (decide as (approved: boolean) => Promise<unknown>).call(record, outcome === 'allowed-once')
    },
    async cancel() {
      await (cancel as () => Promise<unknown>).call(record)
    },
  }
}

/**
 * Register an effect-scoped outbound relay handle. No listener is created.
 * Optional Host sessions are probed without adding a required inject.
 * Returns the handle so connect and processMail can run after apply.
 */
export function bindDesktopRelay(
  ctx: {
    readonly get?: (name: string) => unknown
    effect(callback: () => () => void, label: string): void
  },
  config: Config,
): DesktopRelayHandle | undefined {
  const handle = typeof ctx.get === 'function'
    ? prepareDesktopRelay(config, connectOutboundRelay, defaultControl, undefined, { get: ctx.get })
    : prepareDesktopRelay(config)
  if (handle === undefined) return undefined
  ctx.effect(
    () => () => { handle.dispose() },
    'dsh-plugin-desktop: outbound relay',
  )
  return handle
}

/**
 * Copy a minted pairing code to the clipboard. JWT-shaped codes and credential
 * words fail closed. The notification never includes the code.
 */
export function presentDesktopRelayPairingGrant(input: {
  readonly pairingCode: unknown
  readonly copyText: (text: string) => void
  readonly notify?: (notification: { readonly title: string, readonly body: string }) => void
}): { readonly pairingCode: string } {
  const normalized = assertRelayPairingCode(input.pairingCode)
  const pairingCode = `${normalized.slice(0, 4)}-${normalized.slice(4)}`
  input.copyText(pairingCode)
  input.notify?.({
    title: 'Wan Code',
    body: 'Pairing code copied. It expires in five minutes.',
  })
  return { pairingCode }
}

/**
 * Mint from the connected desktop session and copy the code. Missing sockets
 * fail closed so an idle plugin cannot mint.
 */
export async function copyDesktopRelayPairingGrant(
  handle: DesktopRelayHandle,
  presentation: {
    readonly copyText: (text: string) => void
    readonly notify?: (notification: { readonly title: string, readonly body: string }) => void
  },
): Promise<{ readonly pairingCode: string }> {
  const deviceId = handle.connectedDeviceId
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new RelayAuthorizationError('malformed', 'desktop relay is not connected')
  }
  const minted = await handle.mintPairingGrant({ deviceId })
  return presentDesktopRelayPairingGrant({
    pairingCode: minted.pairingCode,
    copyText: presentation.copyText,
    notify: presentation.notify,
  })
}

/**
 * Register a tray command that copies a pairing code. Missing desktopRuntime
 * stays idle without adding a required inject.
 */
export function bindDesktopRelayPairingTray(
  ctx: {
    readonly get?: (name: string) => unknown
    effect(callback: () => () => void, label: string): void
  },
  handle: DesktopRelayHandle,
): void {
  const runtime = typeof ctx.get === 'function'
    ? asRelayPairingPresentation(ctx.get('desktopRuntime'))
    : undefined
  if (runtime === undefined) return
  ctx.effect(() => {
    const registration = runtime.registerTrayItem({
      group: 'tools',
      order: 20,
      label: () => 'Copy Pairing Code',
      enabled: () => handle.connectedDeviceId !== undefined,
      async invoke() {
        try {
          await copyDesktopRelayPairingGrant(handle, runtime)
        } catch {
          runtime.notify?.({
            title: 'Wan Code',
            body: 'Connect the desktop relay before copying a pairing code.',
          })
        }
      },
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: outbound relay pairing code')
}

/**
 * Register a tray command that enrolls on loopback and dials. Missing
 * desktopRuntime stays idle without adding a required inject.
 */
export function bindDesktopRelayConnectTray(
  ctx: {
    readonly get?: (name: string) => unknown
    effect(callback: () => () => void, label: string): void
  },
  handle: DesktopRelayHandle,
  options?: {
    readonly loadIdentity?: () => DesktopRelayIdentity | undefined
    readonly enroll?: typeof enrollOutboundRelayLoopbackDevice
  },
): void {
  const runtime = typeof ctx.get === 'function'
    ? asRelayPairingPresentation(ctx.get('desktopRuntime'))
    : undefined
  if (runtime === undefined) return
  const loadIdentity = options?.loadIdentity ?? probeDesktopRelayIdentity
  ctx.effect(() => {
    const registration = runtime.registerTrayItem({
      group: 'tools',
      order: 19,
      label: () => 'Connect Relay',
      enabled: () => handle.connectedDeviceId === undefined,
      async invoke() {
        try {
          const identity = loadIdentity()
          if (identity === undefined) {
            throw new RelayAuthorizationError('malformed', 'desktop relay identity is required')
          }
          await openDesktopRelayLoopbackSession({
            handle,
            identity,
            ...(options?.enroll === undefined ? {} : { enroll: options.enroll }),
          })
          runtime.notify?.({
            title: 'Wan Code',
            body: 'Desktop relay connected. Copy a pairing code next.',
          })
        } catch {
          runtime.notify?.({
            title: 'Wan Code',
            body: 'Connect a loopback desktop relay after loading the device identity.',
          })
        }
      },
    })
    return () => { registration.dispose() }
  }, 'dsh-plugin-desktop: outbound relay connect')
}

function probeDesktopRelayIdentity(): DesktopRelayIdentity | undefined {
  const home = process.env.DSH_HOME
  if (typeof home !== 'string' || home.length === 0 || /[\0\r\n]/u.test(home)) return undefined
  try {
    return loadDesktopRelayIdentity({ home, store: createWindowsCredentialStore() })
  } catch {
    return undefined
  }
}

function asRelayPairingPresentation(value: unknown): {
  readonly registerTrayItem: (item: DesktopTrayItem) => DesktopTrayItemRegistration
  readonly copyText: (text: string) => void
  readonly notify?: (notification: { readonly title: string, readonly body: string }) => void
} | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const record = value as {
    registerTrayItem?: unknown
    copyText?: unknown
    updates?: { notify?: unknown }
  }
  if (typeof record.registerTrayItem !== 'function' || typeof record.copyText !== 'function') {
    return undefined
  }
  const notify = record.updates !== undefined && typeof record.updates.notify === 'function'
    ? record.updates.notify.bind(record.updates) as (notification: {
      readonly title: string
      readonly body: string
    }) => void
    : undefined
  return {
    registerTrayItem: record.registerTrayItem.bind(value),
    copyText: record.copyText.bind(value),
    notify,
  }
}

/**
 * Register an effect-scoped outbound relay handle. No listener is created.
 * Optional Host sessions are probed without adding a required inject.
 * @param ctx - Host context used for effect disposal and optional lookups.
 * @param config - validated opt-in relay policy.
 */
export function apply(ctx: Context, config: Config): void {
  const handle = bindDesktopRelay(ctx, config)
  if (handle === undefined) return
  bindDesktopRelayConnectTray(ctx, handle)
  bindDesktopRelayPairingTray(ctx, handle)
}
