# @wancode/relay-protocol

[中文](README.zh.md)

Fail-closed remote-control contract and outbound WebSocket client for Wan Code
Cloud Relay (M2). This package authorizes versioned envelopes against
short-lived tokens and registered devices, opens sessions only from a
desktop-signed **outbound** handshake, and dials the relay. It does not listen
on a public interface, store plaintext prompts, or declare a DeepSeek Harness
plugin entry.

## Guarantees

- Unknown protocol versions, malformed envelopes, and plaintext `prompt` /
  `credential` / `toolOutput` fields are rejected before routing.
- Expired tokens, revoked devices, and cross-account actors fail closed.
- The same message id with the same payload is idempotent; a mutated payload is
  treated as replay and rejected.
- Device identity is an Ed25519 signing keypair plus an X25519 encryption
  keypair. Private keys never appear in handshake, ack, or sealed ciphertext.
  A stored identity blob may hold those private keys for a secure store;
  `publicDeviceIdentity` omits them, and a public key that does not match the
  private material fails closed.
- Application prompt, approval, cancel, session-event, and presence frames are
  sealed to the recipient encryption public key. Empty envelope ids fail
  closed before encryption. The relay stores the box
  opaquely; the wrong device key and handshake ciphertext fail closed.
- A handshake must claim `direction: "outbound"` and verify against the
  registered device public key. Inbound claims, untrusted signatures, unknown
  capabilities, and reused nonces fail closed. `createRelayHandshakeNonce`
  uses WebCrypto so a PWA handshake does not import `node:crypto`.
  `createWebCryptoSignedHandshakeEnvelope` signs that handshake the same way.
- Production relay URLs must use `wss:`. Cleartext `ws:` is accepted only for
  loopback. The access token is the first JSON frame, not a query parameter.
  After handshake, the same socket may send sealed application frames, reclaim
  its own mailbox, and acknowledge drained boxes. Device id for reclaim and ack
  comes from the token, never from the client. An online destination receives a
  sealed push on its own outbound socket; the loopback acceptor never opens the
  box. Offline destinations queue the same sealed box. Closing the socket marks
  the handshake device offline.
- Short-lived access tokens are minted per device after a replaceable OIDC
  identity provider verifies the account. The JWKS provider accepts compact
  ES256 or RS256 JWTs from a caller-supplied key set. `fetchOidcJwks` may load
  that set over HTTPS (or loopback HTTP); redirects are re-checked and the
  request never carries credentials. The static provider remains the
  object-shaped test double. Expired assertions, unknown kids, and `none` /
  HMAC algorithms fail closed.
- Device registration binds one Ed25519 public key and one X25519 encryption
  public key to that account. Revocation
  is immediate and the device id cannot be reused.
- Routing delivers a sealed application envelope only to another device on the
  same account. Opaque prompt ciphertext and handshake frames are not routed.
  Cross-account destinations fail closed. Accepted frames consume a
  per-device rate limit; identical retries do not. Audit records stay free of
  prompt, credential, tool-output, and ciphertext fields.
- Offline destinations queue the same sealed box. A reconnecting device drains the
  same mailbox until it acknowledges each frame. Revoked, expired, and
  cross-account reclaim attempts fail closed and drop remaining mail.

Desktop initiates the cloud connection with `connectOutboundRelay`. Before
that handshake, the same default export can `registerOutboundRelayDevice`,
`issueOutboundRelayToken`, `listOutboundRelayDevices`, and
`revokeOutboundRelayDevice` over HTTPS (or loopback HTTP). Device list uses
POST `/v1/devices/list` with the assertion in the body, never on the query
string. Listed signing and encryption keys must be Ed25519 and X25519.
The account list omits rows whose keys fail that check, including rows that
omit an encryption public key. Only live devices on the presented account are returned; private
keys are omitted. Redirects are re-checked, credentials never appear on the
URL or request, and private keys are refused. This package
is not an inbound Host surface. `@wancode/relay-protocol/loopback` is a
127.0.0.1 test acceptor only. `@wancode/relay-protocol/cloud` adds loopback
HTTP device registration, token minting, and the same outbound WebSocket
acceptor; it refuses non-loopback binds and is not part of the default export.
The desktop Host loads `dsh-plugin-desktop/relay` disabled by default and
bundles this dialer without declaring a Yarn workspace link. When enabled, the
plugin derives an HTTPS control origin from the WebSocket URL, then registers,
mints a token, lists same-account devices, or revokes over outbound HTTP before
`connect` opens a socket.
`createStoredDeviceIdentity` encodes the Ed25519 and X25519 pair for a secure
store. `createWebCryptoDeviceIdentity` mints the same blob through WebCrypto
so a PWA does not import `node:crypto`; missing WebCrypto fails closed.
Public views omit private keys; a mutated public key fails closed.
