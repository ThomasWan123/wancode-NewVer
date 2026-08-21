/** Installable PWA shell contract. This module never listens and never caches credentials. */

import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import { assertPwaRelayRecord } from './credentials.ts'
import { createPwaShellIcons } from './icons.ts'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
const CREDENTIAL_QUERY = /token|secret|credential|password|authorization/iu

/** Relative assets the installed shell may cache. */
export const PWA_SHELL_PATHS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/sw.js',
  '/pair.js',
  '/icons/wancode-192.png',
  '/icons/wancode-512.png',
] as const

/** Cache name for the installable shell. Bump when the asset list or worker changes. */
export const PWA_SHELL_CACHE = 'wancode-pwa-shell-v10'

/** Whether activate may keep a Cache Storage name. Unknown names are deleted. */
export type PwaCacheRetention = 'keep' | 'delete'

/** Loopback host policy. No inline script, no credentialed connect-src. */
export const PWA_SHELL_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "connect-src 'self' https: wss: http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*",
  "img-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
].join('; ')

const SHELL_PATHS = new Set<string>(PWA_SHELL_PATHS)

/** Web App Manifest used to install Wan Code on a phone home screen. */
export interface PwaWebManifest {
  readonly name: 'Wan Code'
  readonly short_name: 'Wan Code'
  readonly id: './'
  readonly lang: 'en'
  readonly start_url: './'
  readonly scope: './'
  readonly display: 'standalone'
  readonly background_color: '#0b0f14'
  readonly theme_color: '#0b0f14'
  readonly prefer_related_applications: false
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
    id: './',
    lang: 'en',
    start_url: './',
    scope: './',
    display: 'standalone',
    background_color: '#0b0f14',
    theme_color: '#0b0f14',
    prefer_related_applications: false,
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

/**
 * Keep only the current shell cache. Stale versions, including the previous
 * inline-script shell, are deleted on activate so they cannot be served.
 */
export function decidePwaCacheRetention(name: string): PwaCacheRetention {
  if (typeof name !== 'string' || name.length === 0 || /[\0\r\n]/u.test(name)) {
    throw new RelayAuthorizationError('malformed', 'pwa cache name is required')
  }
  if (CREDENTIAL_QUERY.test(name)) {
    throw new RelayAuthorizationError('plaintext', 'pwa cache name must not carry credentials')
  }
  return name === PWA_SHELL_CACHE ? 'keep' : 'delete'
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
  if (parsed.hash.length > 0) {
    throw new RelayAuthorizationError('plaintext', `${label} must not carry credentials`)
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
    '  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));',
    '});',
    "self.addEventListener('activate', (event) => {",
    '  event.waitUntil(caches.keys().then((names) => Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)))).then(() => self.clients.claim()));',
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
 * Return the pairing page script. It never listens, never stores tokens, and
 * never embeds model credentials.
 */
export function createPwaPairingScriptSource(): string {
  return [
    '/* Wan Code PWA pairing shell. Never listen. Never store credentials. */',
    "'use strict';",
    "if ('serviceWorker' in navigator) {",
    "  navigator.serviceWorker.register('./sw.js');",
    '}',
    'function allowedOrigin(value) {',
    '  var parsed = new URL(value);',
    "  if (parsed.username !== '' || parsed.password !== '') throw new Error('origin');",
    '  parsed.searchParams.forEach(function (_value, key) {',
    "    if (/token|secret|credential|password|authorization/i.test(key)) throw new Error('origin');",
    '  });',
    "  if (parsed.hash.length > 0) throw new Error('origin');",
    "  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '[::1]'))) throw new Error('origin');",
    '  return parsed.origin;',
    '}',
    'function identityRequest(request) {',
    '  return new Promise(function (resolve, reject) {',
    '    request.onsuccess = function () { resolve(request.result); };',
    "    request.onerror = function () { reject(new Error('identity')); };",
    '  });',
    '}',
    'function openIdentityDb() {',
    "  if (typeof indexedDB === 'undefined' || typeof indexedDB.open !== 'function') throw new Error('identity');",
    "  var request = indexedDB.open('wancode-relay-identity', 1);",
    '  request.onupgradeneeded = function () {',
    "    if (!request.result.objectStoreNames.contains('device')) request.result.createObjectStore('device');",
    '  };',
    '  return identityRequest(request);',
    '}',
    'function identityStore(db, mode) {',
    "  return db.transaction('device', mode).objectStore('device');",
    '}',
    'function bytesToBase64(bytes) {',
    "  var view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;",
    "  var binary = '';",
    '  for (var i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);',
    '  return btoa(binary);',
    '}',
    'function randomDeviceId() {',
    '  var bytes = new Uint8Array(16);',
    '  crypto.getRandomValues(bytes);',
    "  var hex = '';",
    "  for (var i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');",
    '  return hex;',
    '}',
    'function mintIdentity() {',
    "  if (!crypto || !crypto.subtle) return Promise.reject(new Error('identity'));",
    '  var subtle = crypto.subtle;',
    '  return Promise.all([',
    "    subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']),",
    "    subtle.generateKey({ name: 'X25519' }, true, ['deriveBits']),",
    '  ]).then(function (pairs) {',
    '    return Promise.all([',
    "      subtle.exportKey('spki', pairs[0].publicKey).then(bytesToBase64),",
    "      subtle.exportKey('pkcs8', pairs[0].privateKey).then(bytesToBase64),",
    "      subtle.exportKey('spki', pairs[1].publicKey).then(bytesToBase64),",
    "      subtle.exportKey('pkcs8', pairs[1].privateKey).then(bytesToBase64),",
    '    ]).then(function (keys) {',
    '      return JSON.stringify({',
    '        protocolVersion: 1,',
    '        deviceId: randomDeviceId(),',
    '        publicKey: keys[0],',
    '        privateKey: keys[1],',
    '        encryptionPublicKey: keys[2],',
    '        encryptionPrivateKey: keys[3],',
    '      });',
    '    });',
    '  });',
    '}',
    'function enrollIdentity() {',
    '  return openIdentityDb().then(function (db) {',
    "    return identityRequest(identityStore(db, 'readonly').get('wancode-relay-identity')).then(function (existing) {",
    "      if (typeof existing === 'string' && existing.length > 0) {",
    '        var parsed = JSON.parse(existing);',
    "        if (parsed && typeof parsed.deviceId === 'string' && /^[0-9a-f]{32}$/.test(parsed.deviceId)) return parsed.deviceId;",
    "        throw new Error('identity');",
    '      }',
    '      return mintIdentity().then(function (blob) {',
    '        var minted = JSON.parse(blob);',
    "        return identityRequest(identityStore(db, 'readwrite').put(blob, 'wancode-relay-identity')).then(function () {",
    '          return minted.deviceId;',
    '        });',
    '      });',
    '    });',
    '  });',
    '}',
    'function rememberedDesktopId() {',
    '  try {',
    "    var raw = sessionStorage.getItem('wancode-relay-desktop');",
    "    if (raw === null || raw === '') return undefined;",
    '    var parsed = JSON.parse(raw);',
    "    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('desktop');",
    "    if ('privateKey' in parsed || 'encryptionPrivateKey' in parsed) throw new Error('desktop');",
    '    var keys = Object.keys(parsed);',
    '    for (var i = 0; i < keys.length; i++) {',
    "      if (/token|secret|credential|password|authorization|privateKey/i.test(keys[i])) throw new Error('desktop');",
    '    }',
    "    if (keys.length !== 2) throw new Error('desktop');",
    "    if (typeof parsed.deviceId !== 'string' || parsed.deviceId.length === 0 || /[\\r\\n]/.test(parsed.deviceId)) throw new Error('desktop');",
    "    if (typeof parsed.encryptionPublicKey !== 'string' || parsed.encryptionPublicKey.length === 0) throw new Error('desktop');",
    '    return parsed.deviceId;',
    '  } catch (error) {',
    "    try { sessionStorage.removeItem('wancode-relay-desktop'); } catch (ignored) {}",
    '    return undefined;',
    '  }',
    '}',
    'function pairingStatus(deviceId) {',
    '  var desktopId = rememberedDesktopId();',
    "  if (typeof deviceId === 'string' && desktopId) return 'Device ' + deviceId + ' remembered desktop ' + desktopId + '. Desktop keys stay on that machine.';",
    "  if (typeof deviceId === 'string') return 'Device ' + deviceId + '. Desktop keys stay on that machine.';",
    "  if (desktopId) return 'Remembered desktop ' + desktopId + '. Desktop keys stay on that machine.';",
    "  return 'Do not paste API keys or tokens.';",
    '}',
    'try {',
    "  var saved = sessionStorage.getItem('wancode-relay-origin');",
    '  if (saved) document.getElementById(\'pair\').elements.origin.value = allowedOrigin(saved);',
    '} catch (error) {',
    "  try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}",
    '}',
    "document.getElementById('status').textContent = pairingStatus();",
    "document.getElementById('pair').addEventListener('submit', function (event) {",
    '  event.preventDefault();',
    "  var status = document.getElementById('status');",
    '  try {',
    "    var origin = allowedOrigin(event.target.elements.origin.value);",
    "    sessionStorage.setItem('wancode-relay-origin', origin);",
    '    enrollIdentity().then(function (deviceId) {',
    '      status.textContent = pairingStatus(deviceId);',
    '    }).catch(function () {',
    "      status.textContent = 'This browser cannot enroll a device identity.';",
    '    });',
    '  } catch (error) {',
    "    try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}",
    "    status.textContent = 'Use HTTPS or loopback HTTP. Do not paste secrets.';",
    '  }',
    '});',
    "document.getElementById('forget').addEventListener('click', function () {",
    "  try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}",
    "  try { sessionStorage.removeItem('wancode-relay-desktop'); } catch (ignored) {}",
    "  document.getElementById('pair').elements.origin.value = '';",
    "  document.getElementById('status').textContent = 'Forgot this origin. Device identity stays in this browser.';",
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
    '  <meta name="mobile-web-app-capable" content="yes">',
    '  <meta name="apple-mobile-web-app-capable" content="yes">',
    '  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
    '  <meta name="apple-mobile-web-app-title" content="Wan Code">',
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
    '      <button type="button" id="forget">Forget pairing</button>',
    '    </form>',
    '    <p id="status">Do not paste API keys or tokens.</p>',
    '  </main>',
    '  <script src="./pair.js"></script>',
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
  readonly 'pair.js': string
} {
  return {
    'index.html': createPwaIndexHtml(),
    'manifest.webmanifest': `${JSON.stringify(createPwaWebManifest(), null, 2)}\n`,
    'sw.js': createPwaServiceWorkerSource(),
    'pair.js': createPwaPairingScriptSource(),
  }
}

/**
 * Static files for an HTTPS origin or the loopback host. This never starts a
 * listener. Icon bytes are included so `cache.addAll` cannot 404.
 */
export function createPwaDeployFiles(): {
  readonly 'index.html': string
  readonly 'manifest.webmanifest': string
  readonly 'sw.js': string
  readonly 'pair.js': string
  readonly 'icons/wancode-192.png': Buffer
  readonly 'icons/wancode-512.png': Buffer
} {
  return {
    ...createPwaShellFiles(),
    ...createPwaShellIcons(),
  }
}
