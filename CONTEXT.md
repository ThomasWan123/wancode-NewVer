# Wancode domain context

## Product

**Wancode NewVer** is a Windows-first coding-agent desktop product built on the
DeepSeek Harness runtime. It is an independent community product and is not an
official DeepSeek application.

## Domain terms

- **Desktop**: the installed Wancode Electron application and its native
  window, tray, terminal, update, profile, and packaging behavior.
- **Harness Runtime**: the pinned official DeepSeek Harness source and published
  packages that own agents, models, tools, sessions, settings, and the Web UI.
- **Profile**: one named Harness composition and its installed plugins.
- **Device**: one registered Wancode Desktop installation with its own key pair
  and revocable cloud identity.
- **Relay**: the Wancode cloud control plane that authenticates users and
  devices and routes encrypted remote messages.
- **Remote Session**: a mobile or channel view of a session that remains owned
  and executed by a paired Desktop.
- **Plugin Manifest**: a signed declaration of package provenance,
  compatibility, and requested capabilities.
- **Marketplace**: the reviewed registry and installation experience for
  signed Plugin Manifests.
- **Channel Adapter**: an implementation that translates one official messaging
  platform API into the Wancode remote protocol.

## Product invariants

1. Harness Runtime source remains read-only in the product repository.
2. The local Harness Host listens only on loopback.
3. The Relay cannot directly execute tools or access local model credentials.
4. Remote commands target an explicit user, Device, and session and are
   idempotent.
5. Sensitive remote payloads are end-to-end encrypted with Device keys.
6. Plugins cannot gain undeclared capabilities after installation.
7. High-risk tool use requires the same approval policy regardless of whether
   input originated from Desktop, PWA, or a Channel Adapter.
