/** Outbound PWA pairing. The controller never listens and never stores model credentials. */

import {
  RelayAuthorizationError,
  assertDeviceEncryptionPublicKey,
  connectOutboundRelay,
  createRelayHandshakeNonce,
  createWebCryptoSealedRelayEnvelope,
  createWebCryptoSignedHandshakeEnvelope,
  issueOutboundRelayToken,
  listOutboundRelayDevices,
  openWebCryptoSealedRelayPayload,
  publicDeviceIdentity,
  registerOutboundRelayDevice,
  revokeOutboundRelayDevice,
  assertOutboundRelayUrl,
  httpUrlFromOutboundRelayUrl,
  outboundRelayUrlFromHttpUrl,
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
  assertPwaPresenceState,
  type RelayNotificationView,
  type RelaySessionView,
} from './session-view.ts'
import { createPwaSessionBoard, type PwaSessionSnapshot } from './session-board.ts'
import {
  resolvePwaRelayIdentity,
  enrollPwaPairingShell,
  type PwaRelayIdentityStorage,
  type PwaRelayIndexedDbFactory,
  type PwaRelayKeyedStorage,
} from './identity.ts'

/** Inputs used to enroll a PWA device and open an outbound session. */
export interface CreatePwaRelayControllerInput {
  readonly httpUrl: string
  readonly url?: string
  readonly assertion: unknown
  readonly identity?: StoredDeviceIdentity
  readonly identityStorage?: PwaRelayIdentityStorage
  readonly indexedDB?: PwaRelayIndexedDbFactory
  readonly desktop?: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  }
  readonly sessionStorage?: PwaRelayKeyedStorage
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

/** Public desktop selection slot. Identity never uses this key. */
export const PWA_RELAY_DESKTOP_STORAGE_KEY = 'wancode-relay-desktop'

/**
 * Refuse an empty desktop, a local-device target, or a key that is not X25519.
 * Follow-ups must seal to another device.
 */
export function assertPwaDesktopSelection(
  desktop: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  },
  selfDeviceId: string,
): void {
  if (typeof desktop.deviceId !== 'string' || desktop.deviceId.length === 0 || /[\0\r\n]/u.test(desktop.deviceId)) {
    throw new RelayAuthorizationError('malformed', 'pwa desktop device id is required')
  }
  if (desktop.deviceId === selfDeviceId) {
    throw new RelayAuthorizationError('malformed', 'pwa desktop must not be the local device')
  }
  assertDeviceEncryptionPublicKey(desktop.encryptionPublicKey)
}

/**
 * Whether a listed device can be a pairing target. Local ids and untrusted
 * encryption keys are omitted rather than offered for follow-ups.
 */
export function isSelectablePwaDesktop(
  device: {
    readonly deviceId: string
    readonly encryptionPublicKey?: string
  },
  selfDeviceId: string,
): boolean {
  if (typeof device.encryptionPublicKey !== 'string') return false
  try {
    assertPwaDesktopSelection({
      deviceId: device.deviceId,
      encryptionPublicKey: device.encryptionPublicKey,
    }, selfDeviceId)
    return true
  } catch {
    return false
  }
}

/**
 * Select the only listed desktop. Zero or multiple candidates fail closed so
 * a poisoned account list cannot pick a peer.
 */
export async function selectSolePwaDesktop(controller: PwaRelayController): Promise<PwaRelayDesktop> {
  const desktops = await controller.listDesktops()
  if (desktops.length !== 1) {
    throw new RelayAuthorizationError('malformed', 'pwa desktop selection is required')
  }
  const desktop = desktops[0]
  if (typeof desktop.encryptionPublicKey !== 'string') {
    throw new RelayAuthorizationError('malformed', 'pwa desktop encryption public key is required')
  }
  controller.selectDesktop({
    deviceId: desktop.deviceId,
    encryptionPublicKey: desktop.encryptionPublicKey,
  })
  return desktop
}

/**
 * Remember a public desktop selection in sessionStorage. Private keys and the
 * identity slot fail closed.
 */
export function rememberPwaSelectedDesktop(
  storage: PwaRelayKeyedStorage,
  desktop: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  },
  selfDeviceId: string,
): void {
  assertPwaRelayRecord(desktop as unknown as Record<string, unknown>, 'pwa relay desktop')
  assertPwaDesktopSelection(desktop, selfDeviceId)
  storage.setItem(PWA_RELAY_DESKTOP_STORAGE_KEY, JSON.stringify({
    deviceId: desktop.deviceId,
    encryptionPublicKey: desktop.encryptionPublicKey,
  }))
}

/** Drop a remembered public desktop selection. Identity storage is untouched. */
export function forgetPwaSelectedDesktop(storage: PwaRelayKeyedStorage): void {
  storage.removeItem(PWA_RELAY_DESKTOP_STORAGE_KEY)
}

/**
 * Revoke the PWA device immediately and forget the public desktop selection.
 * IndexedDB identity is left in place so a later enroll can mint a new registration.
 */
export async function unpairPwaRelay(input: {
  readonly controller: PwaRelayController
  readonly sessionStorage: PwaRelayKeyedStorage
}): Promise<{
  readonly deviceId: string
  readonly revokedAt: number
}> {
  assertPwaRelayRecord(input as unknown as Record<string, unknown>, 'pwa relay pairing')
  const revoked = await input.controller.revoke()
  forgetPwaSelectedDesktop(input.sessionStorage)
  return revoked
}

/**
 * Reload a public desktop selection. Missing rows return undefined. Private
 * keys, the origin key, and the identity key fail closed.
 */
export function loadPwaSelectedDesktop(
  storage: PwaRelayKeyedStorage,
  selfDeviceId: string,
): {
  readonly deviceId: string
  readonly encryptionPublicKey: string
} | undefined {
  const raw = storage.getItem(PWA_RELAY_DESKTOP_STORAGE_KEY)
  if (raw === null || raw === '') return undefined
  if (typeof raw !== 'string' || /[\0\r\n]/u.test(raw)) {
    throw new RelayAuthorizationError('malformed', 'pwa relay desktop is required')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new RelayAuthorizationError('malformed', 'pwa relay desktop is not json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new RelayAuthorizationError('malformed', 'pwa relay desktop must be an object')
  }
  const record = parsed as Record<string, unknown>
  assertPwaRelayRecord(record, 'pwa relay desktop')
  if (typeof record.deviceId !== 'string' || typeof record.encryptionPublicKey !== 'string') {
    throw new RelayAuthorizationError('malformed', 'pwa relay desktop is required')
  }
  const desktop = {
    deviceId: record.deviceId,
    encryptionPublicKey: record.encryptionPublicKey,
  }
  assertPwaDesktopSelection(desktop, selfDeviceId)
  return desktop
}

/**
 * Register the PWA device, mint a token, and dial the relay outbound.
 * Model credentials are refused. The desktop keeps those keys locally.
 * When `url` is omitted, the WebSocket URL is derived from `httpUrl`.
 */
export async function createPwaRelayController(
  input: CreatePwaRelayControllerInput,
): Promise<PwaRelayController> {
  assertPwaRelayRecord(input as unknown as Record<string, unknown>, 'pwa relay pairing')
  const urls = resolvePwaRelayUrls(input)
  if (input.assertion !== null && typeof input.assertion === 'object' && !Array.isArray(input.assertion)) {
    assertPwaRelayRecord(input.assertion as Record<string, unknown>, 'pwa relay assertion')
  }
  const userId = assertionUserId(input.assertion)
  const identity = await resolvePwaRelayIdentity(input)
  const published = publicDeviceIdentity(identity)
  if (input.desktop !== undefined) {
    assertPwaRelayRecord(input.desktop as unknown as Record<string, unknown>, 'pwa relay desktop')
    assertPwaDesktopSelection(input.desktop, published.deviceId)
    persistPwaSelectedDesktop(input.sessionStorage, input.desktop, published.deviceId)
  }
  const now = input.now ?? Date.now()
  await registerOutboundRelayDevice({
    httpUrl: urls.httpUrl,
    assertion: input.assertion,
    deviceId: published.deviceId,
    publicKey: published.publicKey,
    encryptionPublicKey: published.encryptionPublicKey,
  })
  let selected = input.desktop
  let connection = await openSession({ ...input, ...urls }, identity, published, userId, now)
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
      envelope: await createWebCryptoSealedRelayEnvelope({
        id,
        sentAt: now,
        actor: { userId: connection.userId, deviceId: connection.deviceId },
        kind,
        sender: identity.keyPair,
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
        httpUrl: urls.httpUrl,
        assertion: input.assertion,
      })
      return devices.filter(device => isSelectablePwaDesktop(device, published.deviceId))
    },
    selectDesktop(desktop) {
      assertPwaRelayRecord(desktop as unknown as Record<string, unknown>, 'pwa relay desktop')
      assertPwaDesktopSelection(desktop, published.deviceId)
      persistPwaSelectedDesktop(input.sessionStorage, desktop, published.deviceId)
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
      assertPwaPresenceState(presence.state)
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
        const payload = await openWebCryptoSealedRelayPayload(envelope, identity.keyPair)
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
      connection = await openSession({ ...input, ...urls }, identity, published, userId, now)
      closed = false
    },
    async revoke() {
      closed = true
      connection.close()
      return revokeOutboundRelayDevice({
        httpUrl: urls.httpUrl,
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
  input: { readonly httpUrl: string, readonly url: string, readonly assertion: unknown },
  identity: StoredDeviceIdentity,
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
    envelope: await createWebCryptoSignedHandshakeEnvelope({
      id: `hs:${published.deviceId}:${nonce}`,
      sentAt: now,
      actor: { userId, deviceId: published.deviceId },
      keyPair: identity.keyPair,
      nonce,
      capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
    }),
  })
}

/**
 * Derive the outbound WebSocket URL from a pairing origin. Mismatched HTTP and
 * WebSocket origins fail closed before enroll.
 */
function resolvePwaRelayUrls(input: {
  readonly httpUrl: string
  readonly url?: string
}): { readonly httpUrl: string, readonly url: string } {
  const http = assertPwaShellOrigin(input.httpUrl)
  if (input.url === undefined) {
    return {
      httpUrl: http.href,
      url: outboundRelayUrlFromHttpUrl(http.href).href,
    }
  }
  const websocket = assertOutboundRelayUrl(input.url)
  if (httpUrlFromOutboundRelayUrl(websocket.href).origin !== http.origin) {
    throw new RelayAuthorizationError('malformed', 'pwa relay http origin must match the websocket url')
  }
  return { httpUrl: http.href, url: websocket.href }
}

/**
 * Remember the pairing origin, load IndexedDB identity, register, and dial.
 * Private keys stay in IndexedDB. Model credentials are refused.
 */
export async function openPwaRelayFromOrigin(input: {
  readonly origin: string
  readonly assertion: unknown
  readonly sessionStorage: PwaRelayKeyedStorage
  readonly indexedDB: PwaRelayIndexedDbFactory
  readonly desktop?: CreatePwaRelayControllerInput['desktop']
  readonly now?: number
}): Promise<PwaRelayController> {
  assertPwaRelayRecord(input as unknown as Record<string, unknown>, 'pwa relay pairing')
  const enrolled = await enrollPwaPairingShell({
    origin: input.origin,
    sessionStorage: input.sessionStorage,
    indexedDB: input.indexedDB,
  })
  const desktop = input.desktop ?? loadPwaSelectedDesktop(input.sessionStorage, enrolled.deviceId)
  return createPwaRelayController({
    httpUrl: enrolled.origin,
    assertion: input.assertion,
    indexedDB: input.indexedDB,
    sessionStorage: input.sessionStorage,
    ...(desktop === undefined ? {} : { desktop }),
    ...(input.now === undefined ? {} : { now: input.now }),
  })
}

function persistPwaSelectedDesktop(
  storage: PwaRelayKeyedStorage | undefined,
  desktop: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  },
  selfDeviceId: string,
): void {
  if (storage === undefined) return
  rememberPwaSelectedDesktop(storage, desktop, selfDeviceId)
}

function assertionUserId(assertion: unknown): string {
  if (assertion !== null && typeof assertion === 'object' && !Array.isArray(assertion)) {
    const sub = (assertion as Record<string, unknown>).sub
    if (typeof sub === 'string' && sub.length > 0 && !/[\0\r\n]/u.test(sub)) return sub
  }
  throw new RelayAuthorizationError('malformed', 'pwa relay assertion subject is required')
}
