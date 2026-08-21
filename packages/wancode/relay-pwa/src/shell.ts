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
export const PWA_SHELL_CACHE = 'wancode-pwa-shell-v14'

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
    'function allowedPairingCode(value) {',
    "  if (typeof value !== 'string') throw new Error('pair');",
    "  var trimmed = value.replace(/^\\s+|\\s+$/g, '');",
    "  if (trimmed === '') return '';",
    "  if (trimmed.indexOf('.') !== -1) throw new Error('pair');",
    "  if (/token|secret|credential|password|authorization/i.test(trimmed)) throw new Error('pair');",
    "  var normalized = trimmed.toUpperCase().replace(/[-\\s]/g, '');",
    "  if (!/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/.test(normalized)) throw new Error('pair');",
    "  return normalized.slice(0, 4) + '-' + normalized.slice(4);",
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
    'function base64ToBytes(value) {',
    '  var binary = atob(value);',
    '  var bytes = new Uint8Array(binary.length);',
    '  for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
    '  return bytes;',
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
    '      function publicIdentity(parsed) {',
    "        if (!parsed || typeof parsed.deviceId !== 'string' || !/^[0-9a-f]{32}$/.test(parsed.deviceId)) throw new Error('identity');",
        "        if (typeof parsed.publicKey !== 'string' || typeof parsed.encryptionPublicKey !== 'string' || typeof parsed.privateKey !== 'string' || typeof parsed.encryptionPrivateKey !== 'string') throw new Error('identity');",
        '        return { deviceId: parsed.deviceId, publicKey: parsed.publicKey, encryptionPublicKey: parsed.encryptionPublicKey, privateKey: parsed.privateKey, encryptionPrivateKey: parsed.encryptionPrivateKey };',
    '      }',
    "      if (typeof existing === 'string' && existing.length > 0) return publicIdentity(JSON.parse(existing));",
    '      return mintIdentity().then(function (blob) {',
    '        var minted = JSON.parse(blob);',
    "        return identityRequest(identityStore(db, 'readwrite').put(blob, 'wancode-relay-identity')).then(function () {",
    '          return publicIdentity(minted);',
    '        });',
    '      });',
    '    });',
    '  });',
    '}',
    'function rememberPublicDesktop(desktop, selfDeviceId) {',
    "  if (!desktop || typeof desktop !== 'object' || Array.isArray(desktop)) throw new Error('desktop');",
    "  if ('privateKey' in desktop || 'encryptionPrivateKey' in desktop) throw new Error('desktop');",
    "  if (typeof desktop.deviceId !== 'string' || desktop.deviceId.length === 0 || desktop.deviceId === selfDeviceId) throw new Error('desktop');",
    "  if (typeof desktop.encryptionPublicKey !== 'string' || desktop.encryptionPublicKey.length === 0) throw new Error('desktop');",
    "  sessionStorage.setItem('wancode-relay-desktop', JSON.stringify({ deviceId: desktop.deviceId, encryptionPublicKey: desktop.encryptionPublicKey }));",
    '}',
    'function redeemPairing(origin, pairingCode, identity) {',
    "  return fetch(origin + '/v1/pairing/redeem', {",
    "    method: 'POST',",
    '    headers: { accept: \'application/json\', \'content-type\': \'application/json\' },',
    '    body: JSON.stringify({',
    '      pairingCode: pairingCode,',
    '      deviceId: identity.deviceId,',
    '      publicKey: identity.publicKey,',
    '      encryptionPublicKey: identity.encryptionPublicKey,',
    '    }),',
    '  }).then(function (response) {',
    '    return response.json().then(function (json) {',
    "      if (!response.ok) throw new Error('pair');",
    "      if (!json || typeof json !== 'object') throw new Error('pair');",
    "      if ('privateKey' in json || (json.desktop && ('privateKey' in json.desktop || 'encryptionPrivateKey' in json.desktop))) throw new Error('pair');",
    "      if (typeof json.accessToken !== 'string' || json.accessToken.length === 0) throw new Error('pair');",
    "      if (!json.device || typeof json.device.userId !== 'string' || json.device.userId.length === 0) throw new Error('pair');",
    '      return { desktop: json.desktop, userId: json.device.userId, accessToken: json.accessToken };',
    '    });',
    '  });',
    '}',
    'function relaySocketUrl(origin) {',
    '  var parsed = new URL(origin);',
    "  return (parsed.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + parsed.host + '/v1';",
    '}',
    'function signHandshake(identity, userId, now) {',
    '  var nonce = randomDeviceId();',
    '  var claims = {',
    "    direction: 'outbound',",
    '    nonce: nonce,',
    '    publicKey: identity.publicKey,',
    "    capabilities: ['session.observe', 'session.prompt', 'session.approve', 'session.cancel'],",
    '  };',
    '  var canonical = new TextEncoder().encode(JSON.stringify(claims));',
    "  return crypto.subtle.importKey('pkcs8', base64ToBytes(identity.privateKey), { name: 'Ed25519' }, false, ['sign']).then(function (key) {",
    "    return crypto.subtle.sign({ name: 'Ed25519' }, key, canonical);",
    '  }).then(function (signature) {',
    '    return {',
    '      protocolVersion: 1,',
    "      id: 'hs:' + identity.deviceId + ':' + nonce,",
    "      kind: 'handshake',",
    '      sentAt: now,',
    '      actor: { userId: userId, deviceId: identity.deviceId },',
    "      ciphertext: 'v1:hs:' + bytesToBase64(new TextEncoder().encode(JSON.stringify({ claims: claims, signature: bytesToBase64(signature) }))),",
    '    };',
    '  });',
    '}',
    'var pairedSocket;',
    'var pairedSession;',
    'function dialRelay(origin, accessToken, envelope) {',
    "  if (typeof WebSocket !== 'function') return Promise.reject(new Error('pair'));",
    '  return new Promise(function (resolve, reject) {',
    '    var socket = new WebSocket(relaySocketUrl(origin));',
    '    var timer = setTimeout(function () {',
    '      try { socket.close(); } catch (ignored) {}',
    "      reject(new Error('pair'));",
    '    }, 5000);',
    "    socket.addEventListener('open', function () {",
    '      socket.send(JSON.stringify({ accessToken: accessToken, envelope: envelope }));',
    '    });',
    "    socket.addEventListener('message', function (event) {",
    '      clearTimeout(timer);',
    "      if (typeof event.data !== 'string') {",
    '        try { socket.close(); } catch (ignored) {}',
    "        reject(new Error('pair'));",
    '        return;',
    '      }',
    '      try {',
    '        var ack = JSON.parse(event.data);',
    "        if (!ack || ack.kind !== 'handshake-ack') throw new Error('pair');",
    '      } catch (error) {',
    '        try { socket.close(); } catch (ignored) {}',
    "        reject(new Error('pair'));",
    '        return;',
    '      }',
    '      if (pairedSocket && pairedSocket !== socket) {',
    '        try { pairedSocket.close(); } catch (ignored) {}',
    '      }',
    '      pairedSocket = socket;',
    '      resolve(socket);',
    "    }, { once: true });",
    "    socket.addEventListener('error', function () {",
    '      clearTimeout(timer);',
    "      reject(new Error('pair'));",
    '    });',
    '  });',
    '}',
    'function allowedSession(value) {',
    "  if (typeof value !== 'string') throw new Error('follow');",
    "  var trimmed = value.replace(/^\\s+|\\s+$/g, '');",
    "  if (trimmed === '' || /[\\r\\n]/.test(trimmed) || /token|secret|credential|password|authorization/i.test(trimmed)) throw new Error('follow');",
    '  return trimmed;',
    '}',
    'function allowedFollow(value) {',
    "  if (typeof value !== 'string' || value.length === 0 || value.length > 8192 || /\\0/.test(value)) throw new Error('follow');",
    '  return value;',
    '}',
    'function sealBox(senderPrivateKey, senderPublicKey, recipientPublicKey, envelopeId, aad, plaintext) {',
    '  var subtle = crypto.subtle;',
    "  return Promise.all([",
    "    subtle.importKey('pkcs8', base64ToBytes(senderPrivateKey), { name: 'X25519' }, false, ['deriveBits']),",
    "    subtle.importKey('spki', base64ToBytes(recipientPublicKey), { name: 'X25519' }, false, []),",
    '  ]).then(function (keys) {',
    "    return subtle.deriveBits({ name: 'X25519', public: keys[1] }, keys[0], 256);",
    '  }).then(function (shared) {',
    "    return subtle.importKey('raw', shared, 'HKDF', false, ['deriveBits']).then(function (hkdfKey) {",
    '      return subtle.deriveBits({',
    "        name: 'HKDF',",
    "        hash: 'SHA-256',",
    '        salt: new TextEncoder().encode(envelopeId),',
    "        info: new TextEncoder().encode('wancode-relay-v1'),",
    '      }, hkdfKey, 256);',
    '    });',
    '  }).then(function (keyBytes) {',
    "    return subtle.importKey('raw', keyBytes, { name: 'AES-GCM' }, false, ['encrypt']).then(function (aesKey) {",
    '      var iv = crypto.getRandomValues(new Uint8Array(12));',
    '      return subtle.encrypt({ name: \'AES-GCM\', iv: iv, additionalData: aad, tagLength: 128 }, aesKey, plaintext).then(function (sealedBuf) {',
    '        var sealed = new Uint8Array(sealedBuf);',
    '        if (sealed.byteLength < 16) throw new Error(\'follow\');',
    '        return {',
    "          alg: 'x25519-hkdf-aes-256-gcm',",
    '          senderEncryptionPublicKey: senderPublicKey,',
    '          iv: bytesToBase64(iv),',
    '          tag: bytesToBase64(sealed.slice(sealed.byteLength - 16)),',
    '          ciphertext: bytesToBase64(sealed.slice(0, sealed.byteLength - 16)),',
    '        };',
    '      });',
    '    });',
    '  });',
    '}',
    'function sealFollowUp(session, follow) {',
    '  var now = Date.now();',
    "  var id = 'prompt:' + session.identity.deviceId + ':' + randomDeviceId();",
    "  var payload = { kind: 'prompt', sessionId: follow.sessionId, text: follow.text };",
    '  var actor = { userId: session.userId, deviceId: session.identity.deviceId };',
    "  var aad = new TextEncoder().encode([id, 'prompt', String(now), actor.userId, actor.deviceId, ''].join('\\n'));",
    '  var plaintext = new TextEncoder().encode(JSON.stringify(payload));',
    '  return sealBox(session.identity.encryptionPrivateKey, session.identity.encryptionPublicKey, session.desktop.encryptionPublicKey, id, aad, plaintext).then(function (box) {',
    '    return {',
    '      protocolVersion: 1,',
    '      id: id,',
    "      kind: 'prompt',",
    '      sentAt: now,',
    '      actor: actor,',
    "      ciphertext: 'v1:box:' + bytesToBase64(new TextEncoder().encode(JSON.stringify(box))),",
    '    };',
    '  });',
    '}',
    'function sendSealed(session, envelope) {',
    "  if (!session.socket || session.socket.readyState !== 1) return Promise.reject(new Error('follow'));",
    '  return new Promise(function (resolve, reject) {',
    '    var timer = setTimeout(function () {',
    '      session.socket.removeEventListener(\'message\', onMessage);',
    "      reject(new Error('follow'));",
    '    }, 5000);',
    '    function onMessage(event) {',
    "      if (typeof event.data !== 'string') return;",
    '      try {',
    '        var reply = JSON.parse(event.data);',
    '        if (reply && reply.push) return;',
    '        clearTimeout(timer);',
    "        session.socket.removeEventListener('message', onMessage);",
    "        if (!reply || !reply.delivery || typeof reply.delivery.envelopeId !== 'string') throw new Error('follow');",
    '        resolve(reply.delivery);',
    '      } catch (error) {',
    '        clearTimeout(timer);',
    "        session.socket.removeEventListener('message', onMessage);",
    "        reject(new Error('follow'));",
    '      }',
    '    }',
    "    session.socket.addEventListener('message', onMessage);",
    '    session.socket.send(JSON.stringify({',
    '      accessToken: session.accessToken,',
    '      destinationDeviceId: session.desktop.deviceId,',
    '      envelope: envelope,',
    '    }));',
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
    "    var pair = allowedPairingCode(event.target.elements.pair.value);",
    "    sessionStorage.setItem('wancode-relay-origin', origin);",
    '    enrollIdentity().then(function (identity) {',
    '      if (!pair) {',
    '        status.textContent = pairingStatus(identity.deviceId);',
    '        return;',
    '      }',
    '      return redeemPairing(origin, pair, identity).then(function (redeemed) {',
    '        return signHandshake(identity, redeemed.userId, Date.now()).then(function (envelope) {',
    '          return dialRelay(origin, redeemed.accessToken, envelope);',
    '        }).then(function (socket) {',
    '          pairedSession = { socket: socket, accessToken: redeemed.accessToken, identity: identity, desktop: redeemed.desktop, userId: redeemed.userId };',
    '          rememberPublicDesktop(redeemed.desktop, identity.deviceId);',
    '          status.textContent = pairingStatus(identity.deviceId);',
    '        });',
    '      });',
    '    }).catch(function (error) {',
    "      if (error && (error.message === 'pair' || error.message === 'desktop')) {",
    "        status.textContent = 'Use a pairing code from the desktop. Do not paste tokens.';",
    '        return;',
    '      }',
    "      status.textContent = 'This browser cannot enroll a device identity.';",
    '    });',
    '  } catch (error) {',
    "    if (error && error.message === 'pair') {",
    "      status.textContent = 'Use a pairing code from the desktop. Do not paste tokens.';",
    '      return;',
    '    }',
    "    try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}",
    "    status.textContent = 'Use HTTPS or loopback HTTP. Do not paste secrets.';",
    '  }',
    '});',
    "document.getElementById('follow').addEventListener('submit', function (event) {",
    '  event.preventDefault();',
    "  var status = document.getElementById('status');",
    '  try {',
    '    if (!pairedSession) {',
    "      status.textContent = 'Pair a desktop first.';",
    '      return;',
    '    }',
    "    var follow = { sessionId: allowedSession(event.target.elements.session.value), text: allowedFollow(event.target.elements.follow.value) };",
    '    sealFollowUp(pairedSession, follow).then(function (envelope) {',
    '      return sendSealed(pairedSession, envelope);',
    '    }).then(function () {',
    "      status.textContent = pairingStatus(pairedSession.identity.deviceId) + ' Follow-up sent.';",
    '    }).catch(function () {',
    "      status.textContent = 'Could not send follow-up to that desktop.';",
    '    });',
    '  } catch (error) {',
    "    status.textContent = 'Use a live desktop session. Do not paste tokens.';",
    '  }',
    '});',
    "document.getElementById('forget').addEventListener('click', function () {",
    '  if (pairedSocket) {',
    '    try { pairedSocket.close(); } catch (ignored) {}',
    '  }',
    '  pairedSocket = undefined;',
    '  pairedSession = undefined;',
    "  try { sessionStorage.removeItem('wancode-relay-origin'); } catch (ignored) {}",
    "  try { sessionStorage.removeItem('wancode-relay-desktop'); } catch (ignored) {}",
    "  document.getElementById('pair').elements.origin.value = '';",
    "  document.getElementById('pair').elements.pair.value = '';",
    "  document.getElementById('follow').elements.session.value = '';",
    "  document.getElementById('follow').elements.follow.value = '';",
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
    '      <label>Pairing code <input name="pair" autocomplete="off"></label>',
    '      <button type="submit">Pair desktop</button>',
    '      <button type="button" id="forget">Forget pairing</button>',
    '    </form>',
    '    <form id="follow" method="post" action="#">',
    '      <label>Session <input name="session" required></label>',
    '      <label>Follow-up <textarea name="follow" required></textarea></label>',
    '      <button type="submit">Send to desktop</button>',
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
