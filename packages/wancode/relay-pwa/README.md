# @wancode/relay-pwa

[中文](README.zh.md)

Mobile pairing and session projections for Wan Code Cloud Relay (M3). This
package lets a PWA device enroll over outbound HTTPS, dial outbound WSS, list
same-account desktops, and send sealed follow-ups, approvals, and cancels to a
selected desktop. It can drain reconnect mail, fold streaming progress into
session snapshots, and publish a standalone Web App Manifest whose cache policy
never stores tokens. It does not listen on a public interface, declare a
DeepSeek Harness plugin entry, or store model credentials. Those keys stay on
the desktop.

The package does not declare a Yarn `workspace:` dependency on
`@wancode/relay-protocol`. Tests and source import that contract by relative
path because this checkout lives on a volume that cannot create workspace
directory links.

## Guarantees

- `projectRelaySessionView` maps opened application payloads to a UI-neutral
  view. Prompt text is omitted so logs and snapshots cannot leak it. Progress
  details are capped so low-bandwidth links stay bounded. Empty session ids
  fail closed so snapshots cannot collapse unrelated events. Empty approval
  and cancel request ids also fail closed.
- Model credential field names (`DEEPSEEK_API_KEY`, `apiKey`, and the shared
  plaintext envelope fields) fail closed before pairing or send. Device
  private keys on PWA JSON also fail closed.
-   `createPwaRelayController` registers the PWA device, mints a short-lived
  token, and dials the relay. If `url` is omitted, it is derived from `httpUrl`.
  Mismatched HTTP and WebSocket origins fail closed. `openPwaRelayFromOrigin`
  remembers the origin, loads IndexedDB identity, then enrolls and dials.
  `rememberPwaSelectedDesktop` stores only the public desktop id and encryption key.
  `forgetPwaSelectedDesktop` clears that slot without touching IndexedDB identity.
  Public HTTP origins fail closed before enroll. The desktop may be selected later via
  `listDesktops` / `selectDesktop`. Selecting the local PWA device, an empty
  desktop id, or a non-X25519 encryption key fails closed. `listDesktops`
  omits those same devices. Revoked desktops are omitted. Follow-ups, approvals, and cancels are
  sealed to that desktop encryption public key. Presence frames are sealed the
  same way. Presence state must be online or offline. Follow-up text is required and capped so low-bandwidth links stay
  bounded. Handshake nonces come from WebCrypto, not `node:crypto`. Device
  identities can be minted with `createWebCryptoDeviceIdentity`.
  `loadPwaRelayIdentity` mints once into caller-supplied storage and reloads
  that blob; `peekPwaRelayPublicIdentity` never returns private keys.
  `resolvePwaRelayIdentity` accepts either that store, IndexedDB, or a supplied
  identity, not more than one. `createPwaRelayController` can enroll from
  `identityStorage` or `indexedDB`.
  `bindPwaRelayIdentityStorage` refuses `sessionStorage`, the origin key, and
  credential-like keys. `bindPwaRelayAsyncIdentityStorage` binds IndexedDB-style
  async stores. `openPwaRelayIdentityIndexedDb` opens that store; missing
  IndexedDB fails closed. `enrollPwaPairingShell` remembers a valid origin in
  `sessionStorage` and mints or reloads that IndexedDB identity; private keys
  never share the origin key. Handshake
  signatures use `createWebCryptoSignedHandshakeEnvelope`. Follow-ups are
  sealed with `createWebCryptoSealedRelayEnvelope`. Drain opens those boxes
  with `openWebCryptoSealedRelayPayload`. Closed sessions refuse send and drain until `reconnect`.
  `listDesktops` uses outbound HTTPS and still works after close. `drain` reclaims queued mail
  and live push, then acks only queued ids. `reconnect` mints a fresh nonce so
  the handshake is not replay. `revoke` closes the socket and revokes the PWA
  device id immediately. The returned object does not include private
  keys.
- `createPwaSessionBoard` folds views into one snapshot per session. Prompt
  text never appears. `notify.*` progress becomes the latest notification.
  A denied approval keeps the request id. `assistant.done` and `session.complete` mark the snapshot complete.
- `createPwaWebManifest` returns a standalone install record with a relative
  `start_url`. The install `id` stays relative and `prefer_related_applications`
  is false so the shell can be added to a phone home screen. `decidePwaCacheAction` caches only shell GET assets; token query
  keys and model credentials fail closed. POST control-plane calls stay
  network-only. `decidePwaCacheRetention` keeps only the current shell cache
  name. `createPwaServiceWorkerSource` emits the matching worker; on activate
  it deletes stale caches, then claims clients. It never listens. `createPwaShellFiles` returns `index.html`, the manifest,
  `sw.js`, and `pair.js`. The index has no inline script. `PWA_SHELL_CSP`
  forbids `unsafe-inline`, frames, and plugins. Loopback responses also send
  `X-Content-Type-Options: nosniff`. `createPwaShellIcons` returns the 192 and 512 PNG marks. Checked-in
  copies live under `public/` and must match those generators. `createPwaDeployFiles`
  adds the PNG icons so a static HTTPS origin can host the installable shell
  without this package listening. The index form
  accepts a relay origin and never names token fields. A valid origin may be
  remembered in `sessionStorage` only; hash
  fragments fail closed so `#access_token=` cannot be pasted in. The pairing
  script enrolls a WebCrypto identity into IndexedDB on submit. Apple and Android home-screen metas are present.
  `assertPwaShellOrigin` requires HTTPS or loopback HTTP and refuses
  credentialed URLs, including hash fragments.   `@wancode/relay-pwa/host` may serve that shell on
  127.0.0.1 only; public binds and non-loopback Host, Origin, or Referer
  headers fail
  closed. Loopback responses send `Referrer-Policy: no-referrer` and disable
  camera, microphone, and geolocation. Encoded or `..` paths fail closed.
  It is not part of the default export.
- The default export has no listener and no loopback/cloud acceptor.

This is not yet a shipped iOS or Android install on the public internet.
Graphical launch stays explicit.
