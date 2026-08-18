# @wancode/relay-protocol

[中文](README.zh.md)

Fail-closed remote-control contract for Wan Code Cloud Relay (M2). This package
authorizes versioned envelopes against short-lived tokens and registered
devices, and opens sessions only from a desktop-signed **outbound** handshake.
It does not open a network listener, store plaintext prompts, or declare a
DeepSeek Harness plugin entry.

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

Desktop still initiates any future cloud connection. This library is the
shared protocol core for that outbound path, not an inbound Host surface.
