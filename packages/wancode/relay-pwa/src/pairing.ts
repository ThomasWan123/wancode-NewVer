/** Outbound PWA pairing. The controller never listens and never stores model credentials. */

import {
  RelayAuthorizationError,
  connectOutboundRelay,
  createRelayHandshakeNonce,
  createSealedRelayEnvelope,
  createSignedHandshakeEnvelope,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  openSealedRelayPayload,
  publicDeviceIdentity,
  registerOutboundRelayDevice,
  revokeOutboundRelayDevice,
  assertOutboundRelayUrl,
  type OutboundRelayDevice,
  type RelayApplicationKind,
  type RelayApplicationPayload,
  type StoredDeviceIdentity,
} from '../../relay-protocol/src/index.ts'
import { assertPwaRelayRecord } from './credentials.ts'
import { assertPwaShellOrigin } from './shell.ts'
import {
  projectRelayNotification,
  projectRelaySessionView,
  assertPwaSessionId,
  assertPwaRequestId,
  type RelayNotificationView,
  type RelaySessionView,
} from './session-view.ts'
import { createPwaSessionBoard, type PwaSessionSnapshot } from './session-board.ts'

/** Inputs used to enroll a PWA device and open an outbound session. */
export interface CreatePwaRelayControllerInput {
  readonly httpUrl: string
  readonly url: string
  readonly assertion: unknown
  readonly identity: StoredDeviceIdentity
  readonly desktop?: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  }
  readonly now?: number
}

/** Public desktop a PWA may select. Private keys never appear here. */
export type PwaRelayDesktop = Pick<OutboundRelayDevice, 'deviceId' | 'userId' | 'publicKey' | 'encryptionPublicKey'>

/** Paired outbound controller. Private keys stay inside the closure. */
export interface PwaRelayController {
  readonly deviceId: string
  readonly desktopDeviceId: string | undefined
  listDesktops(): Promise<readonly PwaRelayDesktop[]>
  selectDesktop(desktop: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  }): void
  sendFollowUp(input: {
    readonly id: string
    readonly sessionId: string
    readonly text: string
  }): Promise<PwaRelayDelivery>
  sendApproval(input: {
    readonly id: string
    readonly sessionId: string
    readonly requestId: string
    readonly approved: boolean
  }): Promise<PwaRelayDelivery>
  sendCancel(input: {
    readonly id: string
    readonly sessionId: string
    readonly requestId: string
  }): Promise<PwaRelayDelivery>
  sendPresence(input: {
    readonly id: string
    readonly state: 'online' | 'offline'
  }): Promise<PwaRelayDelivery>
  drain(): Promise<{
    readonly views: readonly RelaySessionView[]
    readonly notifications: readonly RelayNotificationView[]
    readonly sessions: readonly PwaSessionSnapshot[]
  }>
  sessions(): readonly PwaSessionSnapshot[]
  reconnect(): Promise<void>
  revoke(): Promise<{
    readonly deviceId: string
    readonly revokedAt: number
  }>
  project(payload: RelayApplicationPayload): RelaySessionView
  close(): void
}

interface PwaRelayDelivery {
  readonly envelopeId: string
  readonly toDeviceId: string
  readonly outcome: 'delivered' | 'queued' | 'duplicate'
}

const MAX_PWA_FOLLOW_UP_CHARS = 8_192

/**
 * Register the PWA device, mint a token, and dial the relay outbound.
 * Model credentials are refused. The desktop keeps those keys locally.
 */
export async function createPwaRelayController(
  input: CreatePwaRelayControllerInput,
): Promise<PwaRelayController> {
  assertPwaRelayRecord(input as unknown as Record<string, unknown>, 'pwa relay pairing')
  assertPwaShellOrigin(input.httpUrl)
  assertOutboundRelayUrl(input.url)
  if (input.assertion !== null && typeof input.assertion === 'object' && !Array.isArray(input.assertion)) {
    assertPwaRelayRecord(input.assertion as Record<string, unknown>, 'pwa relay assertion')
  }
  if (input.desktop !== undefined) {
    assertPwaRelayRecord(input.desktop as unknown as Record<string, unknown>, 'pwa relay desktop')
  }
  const userId = assertionUserId(input.assertion)
  const published = publicDeviceIdentity(input.identity)
  const now = input.now ?? Date.now()
  await registerOutboundRelayDevice({
    httpUrl: input.httpUrl,
    assertion: input.assertion,
    deviceId: published.deviceId,
    publicKey: published.publicKey,
    encryptionPublicKey: published.encryptionPublicKey,
  })
  let selected = input.desktop
  let connection = await openSession(input, published, userId, now)
  const board = createPwaSessionBoard()
  let closed = false

  function assertOpen(): void {
    if (closed) {
      throw new RelayAuthorizationError('malformed', 'pwa relay session is closed')
    }
  }

  async function sendSealed(
    kind: RelayApplicationKind,
    id: string,
    payload: RelayApplicationPayload,
  ): Promise<PwaRelayDelivery> {
    assertOpen()
    const desktop = selected
    if (desktop === undefined) {
      throw new RelayAuthorizationError('malformed', 'pwa relay desktop is required')
    }
    if (payload.kind !== kind) {
      throw new RelayAuthorizationError('malformed', 'pwa sealed payload kind must match the frame')
    }
    return connection.send({
      envelope: createSealedRelayEnvelope({
        id,
        sentAt: now,
        actor: { userId: connection.userId, deviceId: connection.deviceId },
        kind,
        sender: input.identity.keyPair,
        recipientEncryptionPublicKey: desktop.encryptionPublicKey,
        payload,
      }),
      destinationDeviceId: desktop.deviceId,
    })
  }

  return {
    deviceId: published.deviceId,
    get desktopDeviceId() {
      return selected?.deviceId
    },
    async listDesktops() {
      // Outbound HTTPS; this still works after close() because it does not use the socket.
      const devices = await listOutboundRelayDevices({
        httpUrl: input.httpUrl,
        assertion: input.assertion,
      })
      return devices.filter(device => (
        device.deviceId !== published.deviceId
        && typeof device.encryptionPublicKey === 'string'
      ))
    },
    selectDesktop(desktop) {
      assertPwaRelayRecord(desktop as unknown as Record<string, unknown>, 'pwa relay desktop')
      selected = desktop
    },
    async sendFollowUp(followUp) {
      assertPwaRelayRecord(followUp as unknown as Record<string, unknown>, 'pwa follow-up')
      if (typeof followUp.text !== 'string' || followUp.text.length === 0) {
        throw new RelayAuthorizationError('malformed', 'pwa follow-up text is required')
      }
      if (followUp.text.length > MAX_PWA_FOLLOW_UP_CHARS) {
        throw new RelayAuthorizationError('malformed', 'pwa follow-up text is too large')
      }
      assertPwaSessionId(followUp.sessionId)
      const delivery = await sendSealed('prompt', followUp.id, {
        kind: 'prompt',
        sessionId: followUp.sessionId,
        text: followUp.text,
      })
      board.apply({ kind: 'follow-up', sessionId: followUp.sessionId })
      return delivery
    },
    async sendApproval(approval) {
      assertPwaRelayRecord(approval as unknown as Record<string, unknown>, 'pwa approval')
      assertPwaSessionId(approval.sessionId)
      assertPwaRequestId(approval.requestId)
      const delivery = await sendSealed('approval', approval.id, {
        kind: 'approval',
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        approved: approval.approved,
      })
      board.apply({
        kind: 'approval',
        sessionId: approval.sessionId,
        requestId: approval.requestId,
        approved: approval.approved,
      })
      return delivery
    },
    async sendCancel(cancel) {
      assertPwaRelayRecord(cancel as unknown as Record<string, unknown>, 'pwa cancel')
      assertPwaSessionId(cancel.sessionId)
      assertPwaRequestId(cancel.requestId)
      const delivery = await sendSealed('cancel', cancel.id, {
        kind: 'cancel',
        sessionId: cancel.sessionId,
        requestId: cancel.requestId,
      })
      board.apply({
        kind: 'cancel',
        sessionId: cancel.sessionId,
        requestId: cancel.requestId,
      })
      return delivery
    },
    async sendPresence(presence) {
      assertPwaRelayRecord(presence as unknown as Record<string, unknown>, 'pwa presence')
      return sendSealed('presence', presence.id, {
        kind: 'presence',
        state: presence.state,
      })
    },
    async drain() {
      assertOpen()
      const queued = [...await connection.reclaim()]
      let live: Awaited<ReturnType<typeof connection.receive>> = []
      try {
        live = await connection.receive({ timeoutMs: 25 })
      } catch {
        live = []
      }
      const seen = new Set<string>()
      const views: RelaySessionView[] = []
      const notifications: RelayNotificationView[] = []
      const queuedIds = new Set(queued.map(envelope => envelope.id))
      for (const envelope of [...queued, ...live]) {
        if (seen.has(envelope.id)) continue
        seen.add(envelope.id)
        const payload = openSealedRelayPayload(envelope, input.identity.keyPair)
        const view = projectRelaySessionView(payload)
        views.push(view)
        board.apply(view)
        const notification = projectRelayNotification(view)
        if (notification !== undefined) notifications.push(notification)
        if (queuedIds.has(envelope.id)) {
          await connection.acknowledge({ envelopeId: envelope.id })
        }
      }
      return { views, notifications, sessions: board.list() }
    },
    sessions() {
      return board.list()
    },
    async reconnect() {
      connection.close()
      connection = await openSession(input, published, userId, now)
      closed = false
    },
    async revoke() {
      closed = true
      connection.close()
      return revokeOutboundRelayDevice({
        httpUrl: input.httpUrl,
        assertion: input.assertion,
        deviceId: published.deviceId,
      })
    },
    project: projectRelaySessionView,
    close() {
      closed = true
      connection.close()
    },
  }
}

async function openSession(
  input: CreatePwaRelayControllerInput,
  published: { readonly deviceId: string },
  userId: string,
  now: number,
) {
  const token = await issueOutboundRelayToken({
    httpUrl: input.httpUrl,
    assertion: input.assertion,
    deviceId: published.deviceId,
  })
  const nonce = createRelayHandshakeNonce()
  return connectOutboundRelay({
    url: input.url,
    accessToken: token.accessToken,
    envelope: createSignedHandshakeEnvelope({
      id: `hs:${published.deviceId}:${nonce}`,
      sentAt: now,
      actor: { userId, deviceId: published.deviceId },
      keyPair: input.identity.keyPair,
      nonce,
      capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
    }),
  })
}

function assertionUserId(assertion: unknown): string {
  if (assertion !== null && typeof assertion === 'object' && !Array.isArray(assertion)) {
    const sub = (assertion as Record<string, unknown>).sub
    if (typeof sub === 'string' && sub.length > 0 && !/[\0\r\n]/u.test(sub)) return sub
  }
  throw new RelayAuthorizationError('malformed', 'pwa relay assertion subject is required')
}
