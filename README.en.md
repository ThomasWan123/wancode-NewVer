<p align="center">
  <img src="dsh-plugin-desktop/build/app-icon.png" width="96" height="96" alt="WanCodeNewVer">
</p>

<h1 align="center">WanCodeNewVer</h1>

<p align="center">
  <strong>A Windows-first, local-first coding-agent desktop</strong><br>
  Pinned DeepSeek Harness is the agent runtime. WanCodeNewVer owns the desktop experience, security boundary, updates, and upcoming remote control.
</p>

<p align="center">
  <a href="https://github.com/ThomasWan123/wancode-NewVer/actions/workflows/ci.yml"><img src="https://github.com/ThomasWan123/wancode-NewVer/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <a href="package.json"><img src="https://img.shields.io/badge/node-22.19%2B%20%7C%2024.x-brightgreen.svg" alt="Node.js"></a>
</p>

<p align="center">
  <a href="README.md">中文</a>
  ·
  <a href="docs/WANCODE_REMAKE_PLAN.md">Delivery plan</a>
  ·
  <a href="docs/adr/0001-product-runtime-separation.md">Architecture decision</a>
  ·
  <a href="UPSTREAM.md">Upstream policy</a>
  ·
  <a href="CONTRIBUTING.en.md">Contributing</a>
</p>

> WanCodeNewVer is an independent community product, not an official DeepSeek application. DeepSeek Harness is the attributed upstream runtime; it is not this product's name.

## Positioning

WanCodeNewVer runs the Harness Host on the user's machine and presents the official Web surface in a sandboxed Electron window. The cloud never opens an inbound port on that machine, and it cannot execute local tools or read model credentials. Future remote control uses an outbound connection initiated by the desktop. Sensitive payloads are end-to-end encrypted with device keys.

```text
WanCodeNewVer Desktop ──loopback──> Harness Host ──> Cordis plugins / tools
       │
       └── outbound encrypted WSS ──> WanCodeNewVer Relay <──> Mobile PWA / Channels
```

## Current capabilities

| Area | Status |
| --- | --- |
| Windows desktop core (M1) | **Available**: identity, isolated data, credentials, updates, rollback, crash recovery |
| Local test installer | **Available**: `yarn dist:win` produces an unsigned NSIS package; preview asset is [v2.0.1-unsigned](https://github.com/ThomasWan123/wancode-NewVer/releases/tag/v2.0.1-unsigned) |
| Signed production release | **Deferred** until a code-signing certificate and trusted previous installer exist |
| Cloud relay protocol (M2) | **In progress**: fail-closed contract, JWKS OIDC, outbound HTTPS register/token/revoke, Credential Manager device identity, outbound WSS, routing, rate limits, audit, offline mailbox, same-socket reconnect drain/ack, live sealed-box fan-out, loopback control plane, device-sealed payloads, and an opt-in desktop dialer |
| Mobile PWA (M3) | **In progress**: session snapshots, sealed control, PNG icons, and a loopback static host; model credentials stay on the desktop; public install is not shipped yet |
| Marketplace, channels | Roadmap; not published as available features |

The desktop `master` branch currently includes:

- Native product identity across the application, window, installer, shortcuts, and GitHub update endpoints
- A local Host bound only to `127.0.0.1`, with a sandboxed renderer, context isolation, and no Node integration
- Isolated Electron user data; first launch can copy settings, sessions, and credentials from `~/.dsh` without changing the source
- Telemetry off by default and new sessions pinned to the `read-only` permission preset
- Model keys stored in Windows Credential Manager, with one-time removal of plaintext `.credentials.yaml` after every secure write succeeds
- Relay device private keys stored only in Credential Manager; registration and handshake use the public identity
- Updates from this repository's GitHub Releases; Windows installers must pass PE and Authenticode trust validation
- Stable / beta channels, confirmation-gated rollback, and one automatic Windows recovery after a failed health report
- Renderer crash recovery, **Open Diagnostics Folder**, and `logs/wancode.log`

The Windows-focused gate covers 252 desktop tests plus the runtime-closure verifier. Roadmap work is labeled as planned, not as shipping functionality.

## Repository layout

| Path | Ownership |
| --- | --- |
| `deepseek-harness/` | Read-only, pinned official upstream Git submodule |
| `dsh-plugin-desktop/` | Electron, Host/Client plugins, Windows security, and packaging |
| `packages/wancode/` | WanCodeNewVer protocol, cloud modules, and mobile PWA pairing surface |
| `dsh-community-fabric/` | Community interoperability RFC (documentation scaffold, not loadable) |
| `dsh-community-market/` | Reviewed marketplace contract (documentation scaffold, not loadable) |

Owned modules consume published Harness interfaces and do not modify the submodule.

## Verify from source

Use Windows x64 with Git and Node.js `22.19+` or `24.x`.

```powershell
git clone --recurse-submodules https://github.com/ThomasWan123/wancode-NewVer.git
cd wancode-NewVer
corepack yarn install --immutable
corepack yarn check:layout
corepack yarn workspace dsh-plugin-desktop check:win-package
```

Launch the graphical application explicitly:

```powershell
corepack yarn dev
```

Build an unsigned local test installer:

```powershell
corepack yarn dist:win
```

The unsigned preview installer is also published as GitHub prerelease
[v2.0.1-unsigned](https://github.com/ThomasWan123/wancode-NewVer/releases/tag/v2.0.1-unsigned)
(`WanCodeNewVer-2.0.1-x64-Setup.exe`, SHA-256
`61798CE6E3CC4426C021582A6174A1809F48AAA366AE68292C70A31D07B9BB26`).
Windows SmartScreen will warn. That tag is not Latest and does not replace
published `v2.0.1`. The ~197 MB installer is not committed to Git.

Production signing uses `dist:win-release` and requires a code-signing certificate plus `WANCODE_WINDOWS_PUBLISHER`. This repository never supplies or commits signing secrets.

## Roadmap

1. **Windows desktop core** — delivered as an independently useful local product; signed production packages wait on the certificate.
2. **WanCodeNewVer Cloud Relay** — accounts, device registration, short-lived tokens, revocation, audit, and an end-to-end encrypted protocol.
3. **Mobile PWA** — in progress: session snapshots, sealed control, PNG icons, and a loopback host; public install is not delivered yet.
4. **Reviewed plugin marketplace** — signed manifests, declared capabilities, compatibility checks, atomic activation, and rollback.
5. **Messaging channels** — official APIs for Feishu, Discord, WhatsApp, and compliant WeChat where available.

See [`docs/WANCODE_REMAKE_PLAN.md`](docs/WANCODE_REMAKE_PLAN.md) for milestones and exit criteria.

## Documentation

- [Architecture decision ADR-0001](docs/adr/0001-product-runtime-separation.md)
- [Upstream pinning and update policy](UPSTREAM.md)
- [Desktop package notes](dsh-plugin-desktop/README.md)
- [Contributing](CONTRIBUTING.en.md)

## License

WanCodeNewVer-owned code is released under the [MIT License](LICENSE). Licenses and attribution for DeepSeek Harness, Cordis, and third-party components are retained. Please file issues at [GitHub Issues](https://github.com/ThomasWan123/wancode-NewVer/issues).
