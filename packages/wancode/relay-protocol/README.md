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
- Device identity is an Ed25519 keypair. The private key never appears in
  handshake or ack ciphertext.
- A handshake must claim `direction: "outbound"` and verify against the
  registered device public key. Inbound claims, untrusted signatures, unknown
  capabilities, and reused nonces fail closed.
- Production relay URLs must use `wss:`. Cleartext `ws:` is accepted only for
  loopback. The access token is the first JSON frame, not a query parameter.
- Short-lived access tokens are minted per device after a replaceable OIDC
  identity provider verifies the account. The static provider is the seam for a
  later JWKS-backed factory. Expired assertions and tokens fail closed.
- Device registration binds one Ed25519 public key to that account. Revocation
  is immediate and the device id cannot be reused.

Desktop initiates the cloud connection with `connectOutboundRelay`. This package
is not an inbound Host surface. `@wancode/relay-protocol/loopback` is a
127.0.0.1 test acceptor only and is not part of the default export.
