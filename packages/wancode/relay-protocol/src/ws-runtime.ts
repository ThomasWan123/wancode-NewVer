/** CJS interop for `ws` under NodeNext and verbatimModuleSyntax. */

import { createRequire } from 'node:module'
import type { Server } from 'node:http'

/** Minimal client socket used by the outbound dialer and loopback acceptor. */
export interface RelayWebSocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  terminate(): void
  once(event: 'open', listener: () => void): this
  once(event: 'message', listener: (data: unknown) => void): this
  once(event: 'error', listener: (cause: Error) => void): this
  once(event: 'close', listener: () => void): this
  off(event: 'open', listener: () => void): this
  off(event: 'message', listener: (data: unknown) => void): this
  off(event: 'error', listener: (cause: Error) => void): this
  off(event: 'close', listener: () => void): this
}

interface RelayWebSocketConstructor {
  new (url: URL | string): RelayWebSocket
  readonly OPEN: number
  readonly WebSocketServer: {
    new (options: { server: Server }): RelayWebSocketServer
  }
}

/** Minimal server used by the loopback test acceptor. */
export interface RelayWebSocketServer {
  on(event: 'connection', listener: (socket: RelayWebSocket) => void): this
  close(cb?: (error?: Error) => void): void
}

const loaded = createRequire(import.meta.url)('ws') as RelayWebSocketConstructor

/** WebSocket client constructor from the `ws` package. */
export const NodeWebSocket = loaded

/** WebSocket server constructor from the `ws` package. */
export const NodeWebSocketServer = loaded.WebSocketServer
