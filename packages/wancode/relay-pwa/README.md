# @wancode/relay-pwa

[中文](README.zh.md)

Mobile pairing and session projections for Wan Code Cloud Relay (M3). This
package lets a PWA device enroll over outbound HTTPS, dial outbound WSS, and
send sealed follow-ups to a paired desktop. It does not listen on a public
interface, declare a DeepSeek Harness plugin entry, or store model credentials.
Those keys stay on the desktop.

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
  token, and dials the relay. Follow-ups are sealed to the desktop encryption
  public key. The returned object does not include private keys.
- The default export has no listener and no loopback/cloud acceptor.

This is not an installable iOS or Android PWA yet. Graphical launch is out of
scope for the headless pairing contract.
