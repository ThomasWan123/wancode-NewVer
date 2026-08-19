/** Loopback-only relay acceptor for tests and local proofs. Never bind a public interface. */

import { createServer } from 'node:http'
import {
  createMemoryRelayMailbox,
  createMemoryRelayPresence,
  type RelayMailbox,
  type RelayPresence,
} from './delivery.ts'
import type { RelayRouteStore } from './route.ts'
import { attachRelaySocket, createRelayLiveSink } from './acceptor.ts'
import { NodeWebSocketServer, type RelayWebSocket } from './ws-runtime.ts'

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
  const live = createRelayLiveSink(liveSockets)
  const wss = new NodeWebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    attachRelaySocket(socket, { store: input.store, mailbox, presence, now }, sockets, liveSockets, live)
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
