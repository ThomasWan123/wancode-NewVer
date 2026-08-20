/** Installable PWA shell contract. This module never listens and never caches credentials. */

import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import { assertPwaRelayRecord } from './credentials.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const CREDENTIAL_QUERY = /token|secret|credential|password|authorization/iu

/** Relative assets the installed shell may cache. */
export const PWA_SHELL_PATHS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/sw.js',
  '/icons/wancode-192.png',
  '/icons/wancode-512.png',
] as const

/** Cache name for the installable shell. Bump when the asset list changes. */
export const PWA_SHELL_CACHE = 'wancode-pwa-shell-v1'

const SHELL_PATHS = new Set<string>(PWA_SHELL_PATHS)

/** Web App Manifest used to install Wan Code on a phone home screen. */
export interface PwaWebManifest {
  readonly name: 'Wan Code'
  readonly short_name: 'Wan Code'
  readonly start_url: './'
  readonly scope: './'
  readonly display: 'standalone'
  readonly background_color: '#0b0f14'
  readonly theme_color: '#0b0f14'
  readonly icons: readonly [
    {
      readonly src: './icons/wancode-192.png'
      readonly sizes: '192x192'
      readonly type: 'image/png'
      readonly purpose: 'any'
    },
    {
      readonly src: './icons/wancode-512.png'
      readonly sizes: '512x512'
      readonly type: 'image/png'
      readonly purpose: 'any maskable'
    },
  ]
}

/** Cache policy for one service-worker fetch. The worker itself never listens. */
export type PwaCacheDecision = 'cache-shell' | 'network-only'

/**
 * Return the installable Web App Manifest. URLs stay relative so a token cannot
 * be baked into start_url. Model credentials are refused if supplied.
 */
export function createPwaWebManifest(
  extras: Record<string, unknown> = {},
): PwaWebManifest {
  assertPwaRelayRecord(extras, 'pwa web manifest')
  return {
    name: 'Wan Code',
    short_name: 'Wan Code',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#0b0f14',
    theme_color: '#0b0f14',
    icons: [
      {
        src: './icons/wancode-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: './icons/wancode-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }
}

/**
 * Decide whether a service worker may cache, pass through, or refuse a request.
 * Credentialed URLs and token query keys fail closed. POST control-plane calls
 * stay network-only so tokens are never written to Cache Storage.
 */
export function decidePwaCacheAction(input: {
  readonly method: string
  readonly url: string
}): PwaCacheDecision {
  assertPwaRelayRecord(input as unknown as Record<string, unknown>, 'pwa cache request')
  const parsed = parsePwaRequestUrl(input.url)
  if (input.method !== 'GET' && input.method !== 'HEAD') return 'network-only'
  if (SHELL_PATHS.has(parsed.pathname)) return 'cache-shell'
  return 'network-only'
}

function parsePwaRequestUrl(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url, 'https://pwa.wancode.example/')
  } catch {
    throw new RelayAuthorizationError('malformed', 'pwa cache url is not a valid url')
  }
  return assertPwaTransportUrl(parsed, 'pwa cache url')
}

/**
 * Accept only HTTPS origins, or loopback HTTP for local preview.
 * Credentialed URLs fail closed. This is not a public listener.
 */
export function assertPwaShellOrigin(url: string): URL {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new RelayAuthorizationError('malformed', 'pwa shell origin is not a valid url')
  }
  return assertPwaTransportUrl(parsed, 'pwa shell origin')
}

function assertPwaTransportUrl(parsed: URL, label: string): URL {
  if (parsed.username !== '' || parsed.password !== '') {
    throw new RelayAuthorizationError('plaintext', `${label} must not embed credentials`)
  }
  for (const key of parsed.searchParams.keys()) {
    if (CREDENTIAL_QUERY.test(key)) {
      throw new RelayAuthorizationError('plaintext', `${label} must not carry credentials`)
    }
  }
  if (parsed.protocol === 'https:') return parsed
  if (parsed.protocol === 'http:' && LOOPBACK_HOSTS.has(parsed.hostname)) return parsed
  if (parsed.protocol === 'http:') {
    throw new RelayAuthorizationError(
      'cleartext-transport',
      `cleartext ${label} is only allowed to loopback`,
    )
  }
  throw new RelayAuthorizationError('malformed', `${label} must use https or loopback http`)
}

/**
 * Return the service-worker source for the installable shell.
 * The worker only caches relative GET assets. It never listens and never
 * writes token query strings into Cache Storage.
 */
export function createPwaServiceWorkerSource(): string {
  return [
    '/* Wan Code PWA shell. Never listen. Never cache credentials. */',
    `'use strict';`,
    `const CACHE = ${JSON.stringify(PWA_SHELL_CACHE)};`,
    `const SHELL = ${JSON.stringify([...PWA_SHELL_PATHS])};`,
    'const CREDENTIAL_QUERY = /token|secret|credential|password|authorization/iu;',
    "self.addEventListener('install', (event) => {",
    '  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));',
    '});',
    "self.addEventListener('fetch', (event) => {",
    '  const request = event.request;',
    '  const url = new URL(request.url);',
    '  if (url.username !== "" || url.password !== "") return;',
    '  for (const key of url.searchParams.keys()) {',
    '    if (CREDENTIAL_QUERY.test(key)) return;',
    '  }',
    '  if (request.method !== "GET" && request.method !== "HEAD") return;',
    '  if (!SHELL.includes(url.pathname)) return;',
    '  event.respondWith(caches.open(CACHE).then((cache) => cache.match(request).then((hit) => hit || fetch(request))));',
    '});',
    '',
  ].join('\n')
}

/**
 * Return the installable index document. It registers the shell worker and
 * never embeds tokens or model credentials.
 */
export function createPwaIndexHtml(): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    '  <meta name="theme-color" content="#0b0f14">',
    '  <link rel="manifest" href="./manifest.webmanifest">',
    '  <link rel="apple-touch-icon" href="./icons/wancode-192.png">',
    '  <title>Wan Code</title>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>Wan Code</h1>',
    '    <p>Pair a desktop. Model keys stay on that machine.</p>',
    '    <form id="pair" method="post" action="#">',
    '      <label>Relay origin <input name="origin" type="url" required></label>',
    '      <button type="submit">Pair desktop</button>',
    '    </form>',
    '    <p id="status">Do not paste API keys or tokens.</p>',
    '  </main>',
    '  <script>',
    "    if ('serviceWorker' in navigator) {",
    "      navigator.serviceWorker.register('./sw.js');",
    '    }',
    "    document.getElementById('pair').addEventListener('submit', function (event) {",
    '      event.preventDefault();',
    "      var status = document.getElementById('status');",
    '      try {',
    "        var parsed = new URL(event.target.elements.origin.value);",
    "        if (parsed.username !== '' || parsed.password !== '') throw new Error('origin');",
    "        parsed.searchParams.forEach(function (_value, key) {",
    "          if (/token|secret|credential|password|authorization/i.test(key)) throw new Error('origin');",
    '        });',
    "        if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'))) throw new Error('origin');",
    "        status.textContent = 'Desktop keys stay on that machine.';",
    '      } catch (error) {',
    "        status.textContent = 'Use HTTPS or loopback HTTP. Do not paste secrets.';",
    '      }',
    '    });',
    '  </script>',
    '</body>',
    '</html>',
    '',
  ].join('\n')
}

/** Static files a host can write without starting a listener in this package. */
export function createPwaShellFiles(): {
  readonly 'index.html': string
  readonly 'manifest.webmanifest': string
  readonly 'sw.js': string
} {
  return {
    'index.html': createPwaIndexHtml(),
    'manifest.webmanifest': `${JSON.stringify(createPwaWebManifest(), null, 2)}\n`,
    'sw.js': createPwaServiceWorkerSource(),
  }
}
