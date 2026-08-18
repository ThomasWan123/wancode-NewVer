/** Loopback-only relay acceptor for tests and local proofs. Never bind a public interface. */

import { createServer } from 'node:http'
import { RelayAuthorizationError } from './errors.ts'
import type { RelayStore } from './envelope.ts'
import { openOutboundSession } from './handshake.ts'
import { parseRelayWireHandshake } from './wire.ts'
import { utf8FromSocketData } from './text.ts'
import { NodeWebSocketServer, type RelayWebSocket } from './ws-runtime.ts'

/** Inputs for a 127.0.0.1 WebSocket acceptor that runs openOutboundSession. */
export interface StartLoopbackRelayInput {
  readonly store: RelayStore
  readonly now?: number
}

/** Listening loopback relay. `url` is always `ws://127.0.0.1:<ephemeral>`. */
export interface LoopbackRelay {
  readonly url: string
  readonly address: string
  readonly port: number
  close(): Promise<void>
}

/**
 * Bind an ephemeral port on 127.0.0.1 and accept one outbound handshake per
 * connection. This is not a production cloud listener.
 */
export async function startLoopbackRelay(input: StartLoopbackRelayInput): Promise<LoopbackRelay> {
  const httpServer = createServer((_request, response) => {
    response.writeHead(404)
    response.end()
  })
  const sockets = new Set<RelayWebSocket>()
  const wss = new NodeWebSocketServer({ server: httpServer })
  wss.on('connection', socket => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    socket.once('message', raw => {
      try {
        const parsed = JSON.parse(utf8FromSocketData(raw)) as unknown
        const wire = parseRelayWireHandshake(parsed)
        const session = openOutboundSession({
          envelope: wire.envelope,
          accessToken: wire.accessToken,
          store: input.store,
          now: input.now ?? Date.now(),
        })
        socket.send(JSON.stringify(session.ack))
      } catch (cause) {
        const code = cause instanceof RelayAuthorizationError ? cause.code : 'malformed'
        const message = cause instanceof Error ? cause.message : 'relay handshake failed'
        socket.send(JSON.stringify({ error: { code, message } }))
        socket.close()
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
