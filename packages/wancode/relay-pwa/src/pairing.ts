/** Outbound PWA pairing. The controller never listens and never stores model credentials. */

import {
  RelayAuthorizationError,
  connectOutboundRelay,
  createSealedRelayEnvelope,
  createSignedHandshakeEnvelope,
  issueOutboundRelayToken,
  publicDeviceIdentity,
  registerOutboundRelayDevice,
  type RelayApplicationPayload,
  type StoredDeviceIdentity,
} from '../../relay-protocol/src/index.ts'
import { assertPwaRelayRecord } from './credentials.ts'
import { projectRelaySessionView, type RelaySessionView } from './session-view.ts'

/** Inputs used to enroll a PWA device and open an outbound session. */
export interface CreatePwaRelayControllerInput {
  readonly httpUrl: string
  readonly url: string
  readonly assertion: unknown
  readonly identity: StoredDeviceIdentity
  readonly desktop: {
    readonly deviceId: string
    readonly encryptionPublicKey: string
  }
  readonly now?: number
}

/** Paired outbound controller. Private keys stay inside the closure. */
export interface PwaRelayController {
  readonly deviceId: string
  readonly desktopDeviceId: string
  sendFollowUp(input: {
    readonly id: string
    readonly sessionId: string
    readonly text: string
  }): Promise<{
    readonly envelopeId: string
    readonly toDeviceId: string
    readonly outcome: 'delivered' | 'queued' | 'duplicate'
  }>
  project(payload: RelayApplicationPayload): RelaySessionView
  close(): void
}

/**
 * Register the PWA device, mint a token, and dial the relay outbound.
 * Model credentials are refused. The desktop keeps those keys locally.
 */
export async function createPwaRelayController(
  input: CreatePwaRelayControllerInput,
): Promise<PwaRelayController> {
  assertPwaRelayRecord(input as unknown as Record<string, unknown>, 'pwa relay pairing')
  if (input.assertion !== null && typeof input.assertion === 'object' && !Array.isArray(input.assertion)) {
    assertPwaRelayRecord(input.assertion as Record<string, unknown>, 'pwa relay assertion')
  }
  assertPwaRelayRecord(input.desktop as unknown as Record<string, unknown>, 'pwa relay desktop')
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
  const token = await issueOutboundRelayToken({
    httpUrl: input.httpUrl,
    assertion: input.assertion,
    deviceId: published.deviceId,
  })
  const connection = await connectOutboundRelay({
    url: input.url,
    accessToken: token.accessToken,
    envelope: createSignedHandshakeEnvelope({
      id: `hs:${published.deviceId}`,
      sentAt: now,
      actor: { userId, deviceId: published.deviceId },
      keyPair: input.identity.keyPair,
      nonce: `pwa:${published.deviceId}`,
      capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],
    }),
  })
  return {
    deviceId: published.deviceId,
    desktopDeviceId: input.desktop.deviceId,
    async sendFollowUp(followUp) {
      assertPwaRelayRecord(followUp as unknown as Record<string, unknown>, 'pwa follow-up')
      return connection.send({
        envelope: createSealedRelayEnvelope({
          id: followUp.id,
          sentAt: now,
          actor: { userId: connection.userId, deviceId: connection.deviceId },
          kind: 'prompt',
          sender: input.identity.keyPair,
          recipientEncryptionPublicKey: input.desktop.encryptionPublicKey,
          payload: {
            kind: 'prompt',
            sessionId: followUp.sessionId,
            text: followUp.text,
          },
        }),
        destinationDeviceId: input.desktop.deviceId,
      })
    },
    project: projectRelaySessionView,
    close() {
      connection.close()
    },
  }
}

function assertionUserId(assertion: unknown): string {
  if (assertion !== null && typeof assertion === 'object' && !Array.isArray(assertion)) {
    const sub = (assertion as Record<string, unknown>).sub
    if (typeof sub === 'string' && sub.length > 0 && !/[\0\r\n]/u.test(sub)) return sub
  }
  throw new RelayAuthorizationError('malformed', 'pwa relay assertion subject is required')
}
