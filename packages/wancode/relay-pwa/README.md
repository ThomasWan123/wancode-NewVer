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
  view. Prompt text is omitted so logs and snapshots cannot leak it.
- Model credential field names (`DEEPSEEK_API_KEY`, `apiKey`, and the shared
  plaintext envelope fields) fail closed before pairing or send.
- `createPwaRelayController` registers the PWA device, mints a short-lived
  token, and dials the relay. The desktop may be selected later via
  `listDesktops` / `selectDesktop`. Follow-ups, approvals, and cancels are
  sealed to that desktop encryption public key. `drain` reclaims queued mail
  and live push, then acks only queued ids. `reconnect` mints a fresh nonce so
  the handshake is not replay. The returned object does not include private
  keys.
- `createPwaSessionBoard` folds views into one snapshot per session. Prompt
  text never appears. `notify.*` progress becomes the latest notification.
- `createPwaWebManifest` returns a standalone install record with a relative
  `start_url`. `decidePwaCacheAction` caches only shell GET assets; token query
  keys and model credentials fail closed. POST control-plane calls stay
  network-only.
- The default export has no listener and no loopback/cloud acceptor.

This is not yet a shipped iOS or Android install. The HTML shell, icons, and
service-worker runtime are still out of scope for the headless contract.
Graphical launch stays explicit.
