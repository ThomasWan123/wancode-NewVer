/** Loopback-only static host for the installable PWA shell. Never bind a public interface. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import { createPwaShellIcons } from './icons.ts'
import { createPwaShellFiles } from './shell.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const CREDENTIAL_QUERY = /token|secret|credential|password|authorization/iu

/** Listening loopback shell. `url` is always `http://127.0.0.1:<port>/`. */
export interface PwaShellHost {
  readonly url: string
  readonly address: string
  readonly port: number
  close(): Promise<void>
}

/** Inputs for a 127.0.0.1 static shell. */
export interface StartPwaShellHostInput {
  readonly bindAddress?: string
  readonly port?: number
  readonly files?: Readonly<Record<string, string | Uint8Array>>
}

/**
 * Accept only loopback bind addresses. Public interfaces fail closed.
 */
export function assertPwaShellBindAddress(address: string): string {
  if (typeof address !== 'string' || address.length === 0 || /[\0\r\n]/u.test(address)) {
    throw new RelayAuthorizationError('malformed', 'pwa shell bind address is required')
  }
  if (!LOOPBACK_HOSTS.has(address)) {
    throw new RelayAuthorizationError('inbound-forbidden', 'pwa shell must bind loopback')
  }
  return address === 'localhost' || address === '::1' || address === '[::1]' ? '127.0.0.1' : address
}

/**
 * Serve the installable shell on 127.0.0.1. This is not a public production
 * listener, not a DSH plugin, and is not part of the default export.
 */
export async function startPwaShellHost(
  input: StartPwaShellHostInput = {},
): Promise<PwaShellHost> {
  const bindAddress = assertPwaShellBindAddress(input.bindAddress ?? '127.0.0.1')
  const files = indexShellFiles(input.files ?? defaultShellFiles())
  const httpServer = createServer((request, response) => {
    handleShellHttp(request, response, files)
  })
  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject)
    httpServer.listen(input.port ?? 0, bindAddress, () => resolve())
  })
  const address = httpServer.address()
  if (address === null || typeof address === 'string') {
    httpServer.close()
    throw new RelayAuthorizationError('malformed', 'pwa shell did not bind a tcp port')
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    address: bindAddress,
    port: address.port,
    close() {
      return new Promise((resolve, reject) => {
        httpServer.close(error => error ? reject(error) : resolve())
      })
    },
  }
}

function defaultShellFiles(): Record<string, string | Uint8Array> {
  return {
    ...createPwaShellFiles(),
    ...createPwaShellIcons(),
  }
}

function indexShellFiles(
  files: Readonly<Record<string, string | Uint8Array>>,
): Map<string, { readonly body: Buffer, readonly type: string }> {
  const indexed = new Map<string, { readonly body: Buffer, readonly type: string }>()
  for (const [name, contents] of Object.entries(files)) {
    const path = normalizeShellPath(name)
    const body = typeof contents === 'string' ? Buffer.from(contents) : Buffer.from(contents)
    indexed.set(path, { body, type: contentType(path) })
  }
  const index = indexed.get('/index.html')
  if (index !== undefined) indexed.set('/', index)
  return indexed
}

function handleShellHttp(
  request: IncomingMessage,
  response: ServerResponse,
  files: Map<string, { readonly body: Buffer, readonly type: string }>,
): void {
  try {
    const method = request.method ?? 'GET'
    if (method !== 'GET' && method !== 'HEAD') {
      throw new RelayAuthorizationError('malformed', 'pwa shell method is not supported')
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1/')
    for (const key of url.searchParams.keys()) {
      if (CREDENTIAL_QUERY.test(key)) {
        throw new RelayAuthorizationError('plaintext', 'pwa shell url must not carry credentials')
      }
    }
    const path = normalizeShellPath(url.pathname)
    const file = files.get(path)
    if (file === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': file.type,
      'content-length': file.body.byteLength,
      'cache-control': 'no-store',
    })
    response.end(method === 'HEAD' ? undefined : file.body)
  } catch (cause) {
    const code = cause instanceof RelayAuthorizationError ? cause.code : 'malformed'
    const status = code === 'plaintext' || code === 'inbound-forbidden' ? 403 : 400
    const payload = JSON.stringify({ error: { code } })
    response.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    })
    response.end(payload)
  }
}

function normalizeShellPath(path: string): string {
  const trimmed = path.replace(/\\/gu, '/').replace(/^\/+/u, '').replace(/\/+$/u, '')
  if (trimmed.includes('..') || trimmed.includes('\0')) {
    throw new RelayAuthorizationError('malformed', 'pwa shell path is not allowed')
  }
  return trimmed.length === 0 ? '/' : `/${trimmed}`
}

function contentType(path: string): string {
  if (path.endsWith('.html')) return 'text/html; charset=utf-8'
  if (path.endsWith('.webmanifest')) return 'application/manifest+json; charset=utf-8'
  if (path.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (path.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}
