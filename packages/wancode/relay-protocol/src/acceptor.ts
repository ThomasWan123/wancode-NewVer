/** Shared loopback WebSocket acceptor. Never bind a public interface. */

import {
  acknowledgeRelayMailbox,
  deliverRelayEnvelope,
  reclaimRelayMailbox,
  type RelayLiveSink,
  type RelayMailbox,
  type RelayPresence,
} from './delivery.ts'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayRouteStore } from './route.ts'
import { openOutboundSession } from './handshake.ts'
import { parseRelayWireCommand, parseRelayWireHandshake } from './wire.ts'
import { utf8FromSocketData } from './text.ts'
import { NodeWebSocket, type RelayWebSocket } from './ws-runtime.ts'

/** Runtime pieces one outbound WebSocket connection needs after handshake. */
export interface RelayAcceptorContext {
  readonly store: RelayRouteStore
  readonly mailbox: RelayMailbox
  readonly presence: RelayPresence
  readonly now: number
}

function wireError(cause: unknown): { error: { code: string, message: string } } {
  const code = cause instanceof RelayAuthorizationError ? cause.code : 'malformed'
  const message = cause instanceof Error ? cause.message : 'relay handshake failed'
  return { error: { code, message } }
}

/** Push sealed boxes to the live destination socket without opening them. */
export function createRelayLiveSink(
  liveSockets: Map<string, RelayWebSocket>,
): RelayLiveSink {
  return {
    push(deviceId, envelope) {
      const dest = liveSockets.get(deviceId)
      if (dest === undefined || dest.readyState !== NodeWebSocket.OPEN) return false
      dest.send(JSON.stringify({ push: true, mail: [envelope] }))
      return true
    },
  }
}

/**
 * Accept one outbound handshake, then sealed deliver / reclaim / ack frames.
 * Close marks that handshake device offline.
 */
export function attachRelaySocket(
  socket: RelayWebSocket,
  input: RelayAcceptorContext,
  sockets: Set<RelayWebSocket>,
  liveSockets: Map<string, RelayWebSocket>,
  live: RelayLiveSink,
): void {
  sockets.add(socket)
  let deviceId: string | undefined
  socket.once('close', () => {
    sockets.delete(socket)
    if (deviceId !== undefined) {
      if (liveSockets.get(deviceId) === socket) liveSockets.delete(deviceId)
      input.presence.setOffline(deviceId)
    }
  })
  let opened = false
  socket.on('message', raw => {
    try {
      const parsed = JSON.parse(utf8FromSocketData(raw)) as unknown
      if (!opened) {
        const wire = parseRelayWireHandshake(parsed)
        const session = openOutboundSession({
          envelope: wire.envelope,
          accessToken: wire.accessToken,
          store: input.store,
          now: input.now,
        })
        opened = true
        deviceId = session.deviceId
        liveSockets.set(session.deviceId, socket)
        input.presence.setOnline(session.deviceId, session.sessionId)
        socket.send(JSON.stringify(session.ack))
        return
      }
      const command = parseRelayWireCommand(parsed)
      if (command.kind === 'deliver') {
        const delivery = deliverRelayEnvelope({
          envelope: command.frame.envelope,
          accessToken: command.frame.accessToken,
          destinationDeviceId: command.frame.destinationDeviceId,
          store: input.store,
          mailbox: input.mailbox,
          presence: input.presence,
          live,
          now: input.now,
        })
        socket.send(JSON.stringify({ delivery }))
        return
      }
      const token = input.store.getAccessToken(command.accessToken)
      if (token === undefined || token.expiresAt <= input.now) {
        throw new RelayAuthorizationError('expired-token', 'relay access token is unknown or expired')
      }
      if (command.kind === 'reclaim') {
        const mail = reclaimRelayMailbox({
          accessToken: command.accessToken,
          deviceId: token.deviceId,
          store: input.store,
          mailbox: input.mailbox,
          now: input.now,
        })
        socket.send(JSON.stringify({ mail }))
        return
      }
      const delivery = acknowledgeRelayMailbox({
        accessToken: command.accessToken,
        deviceId: token.deviceId,
        envelopeId: command.envelopeId,
        store: input.store,
        mailbox: input.mailbox,
        now: input.now,
      })
      socket.send(JSON.stringify({ delivery }))
    } catch (cause) {
      socket.send(JSON.stringify(wireError(cause)))
      if (!opened) socket.close()
    }
  })
}
