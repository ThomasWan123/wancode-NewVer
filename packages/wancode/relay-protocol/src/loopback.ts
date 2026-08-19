/** Loopback-only relay acceptor for tests and local proofs. Never bind a public interface. */

import { createServer } from 'node:http'
import {
  acknowledgeRelayMailbox,
  createMemoryRelayMailbox,
  createMemoryRelayPresence,
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
import { NodeWebSocket, NodeWebSocketServer, type RelayWebSocket } from './ws-runtime.ts'

/** Inputs for a 127.0.0.1 WebSocket acceptor that runs openOutboundSession. */
export interface StartLoopbackRelayInput {
  readonly store: RelayRouteStore
  readonly mailbox?: RelayMailbox
  readonly presence?: RelayPresence
  readonly now?: number
}

/** Listening loopback relay. `url` is always `ws://127.0.0.1:<ephemeral>`. */
export interface LoopbackRelay {
  readonly url: string
  readonly address: string
  readonly port: number
  readonly mailbox: RelayMailbox
  readonly presence: RelayPresence
  close(): Promise<void>
}

function wireError(cause: unknown): { error: { code: string, message: string } } {
  const code = cause instanceof RelayAuthorizationError ? cause.code : 'malformed'
  const message = cause instanceof Error ? cause.message : 'relay handshake failed'
  return { error: { code, message } }
}

/**
 * Bind an ephemeral port on 127.0.0.1 and accept one outbound handshake per
 * connection. Later frames are sealed deliveries, mailbox reclaim, or ack.
 * Online destinations receive a sealed push on their own outbound socket.
 * Close marks that handshake device offline. This is not a production cloud
 * listener.
 */
export async function startLoopbackRelay(input: StartLoopbackRelayInput): Promise<LoopbackRelay> {
  const now = input.now ?? Date.now()
  const mailbox = input.mailbox ?? createMemoryRelayMailbox()
  const presence = input.presence ?? createMemoryRelayPresence()
  const httpServer = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  const sockets = new Set<RelayWebSocket>()
  const liveSockets = new Map<string, RelayWebSocket>()
  const live: RelayLiveSink = {
    push(deviceId, envelope) {
      const dest = liveSockets.get(deviceId)
      if (dest === undefined || dest.readyState !== NodeWebSocket.OPEN) return false
      dest.send(JSON.stringify({ push: true, mail: [envelope] }))
      return true
    },
  }
  const wss = new NodeWebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    sockets.add(socket)
    let deviceId: string | undefined
    socket.once('close', () => {
      sockets.delete(socket)
      if (deviceId !== undefined) {
        if (liveSockets.get(deviceId) === socket) liveSockets.delete(deviceId)
        presence.setOffline(deviceId)
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
            now,
          })
          opened = true
          deviceId = session.deviceId
          liveSockets.set(session.deviceId, socket)
          presence.setOnline(session.deviceId, session.sessionId)
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
            mailbox,
            presence,
            live,
            now,
          })
          socket.send(JSON.stringify({ delivery }))
          return
        }
        const token = input.store.getAccessToken(command.accessToken)
        if (token === undefined || token.expiresAt <= now) {
          throw new RelayAuthorizationError('expired-token', 'relay access token is unknown or expired')
        }
        if (command.kind === 'reclaim') {
          const mail = reclaimRelayMailbox({
            accessToken: command.accessToken,
            deviceId: token.deviceId,
            store: input.store,
            mailbox,
            now,
          })
          socket.send(JSON.stringify({ mail }))
          return
        }
        const delivery = acknowledgeRelayMailbox({
          accessToken: command.accessToken,
          deviceId: token.deviceId,
          envelopeId: command.envelopeId,
          store: input.store,
          mailbox,
          now,
        })
        socket.send(JSON.stringify({ delivery }))
      } catch (cause) {
        socket.send(JSON.stringify(wireError(cause)))
        if (!opened) socket.close()
      }
    })
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error)
    httpServer.once('error', onError)
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', onError)
      resolve()
    })
  })

  const address = httpServer.address()
  if (address === null || typeof address === 'string' || address.address !== '127.0.0.1') {
    httpServer.close()
    throw new Error('loopback relay must bind 127.0.0.1')
  }

  return {
    url: `ws://127.0.0.1:${address.port}`,
    address: address.address,
    port: address.port,
    mailbox,
    presence,
    async close() {
      for (const socket of sockets) socket.terminate()
      await new Promise<void>((resolve, reject) => {
        wss.close(error => {
          if (error) reject(error)
          else httpServer.close(closeError => closeError ? reject(closeError) : resolve())
        })
      })
    },
  }
}
