# Wan Code

Wan Code is a Windows-first, local-first Coding Agent desktop product. It uses a
pinned [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
release as its underlying agent runtime, while Wan Code owns the desktop
experience, security boundaries, updates, remote control, and plugin ecosystem.

> Wan Code is an independent community product, not an official DeepSeek
> application. DeepSeek Harness is the attributed upstream runtime used by
> Wan Code; it is not this product's name.

[中文](README.md) · [Delivery plan](docs/WANCODE_REMAKE_PLAN.md) ·
[Architecture decision](docs/adr/0001-product-runtime-separation.md) ·
[Upstream policy](UPSTREAM.md)

## Current status

Development follows a Windows-first delivery path. The current `master` branch
provides:

- **Wan Code native identity** across the application, window, installer,
  shortcuts, and GitHub update endpoints.
- **Local Harness Host** bound only to `127.0.0.1`, with a sandboxed Electron
  renderer, context isolation, and no Node integration.
- **Isolated product data** under Wan Code's Electron user-data directory rather
  than automatically sharing an existing `~/.dsh`.
- **Private defaults** with upstream telemetry disabled unless the user
  explicitly chooses otherwise.
- **Windows-secured credentials** stored in Windows Credential Manager, including
  one-time migration and removal of the legacy plaintext `.credentials.yaml`.
- **Trusted updates** sourced from
  [`ThomasWan123/wancode-NewVer`](https://github.com/ThomasWan123/wancode-NewVer/releases);
  Windows installers must pass PE and Authenticode trust validation.
- **Stable and beta channels** selectable through desktop settings, with an
  orderly restart and persisted prompted-version history.
- **Signed release gates** that require an explicit certificate and expected
  publisher, then verify that the application and NSIS installer use the same
  signing certificate.
- **Plugin-composed desktop capabilities** for windows, tray, profiles, terminal,
  and updates without modifying the pinned Harness submodule.

The Windows-focused gate currently covers 133 tests plus the complete runtime
dependency closure. Roadmap features are described as planned work, not as
already available functionality.

## Product roadmap

1. **Windows desktop core**: install, first run, model setup, task execution,
   session recovery, signed updates, rollback, and uninstall.
2. **Wan Code Cloud Relay**: accounts, device registration, short-lived tokens,
   revocation, audit, and an end-to-end encrypted remote protocol.
3. **Mobile PWA**: session viewing, follow-up prompts, tool approval,
   cancellation, and notifications.
4. **Reviewed plugin marketplace**: signed manifests, declared capabilities,
   compatibility checks, atomic activation, and rollback.
5. **Messaging channels**: official API integrations for Feishu, Discord,
   WhatsApp, and compliant WeChat capabilities where available.

See [`docs/WANCODE_REMAKE_PLAN.md`](docs/WANCODE_REMAKE_PLAN.md) for milestones,
exit criteria, and risk controls.

## Architecture boundary

```text
Wan Code Desktop ──loopback──> Harness Host ──> Cordis plugins / tools
       │
       └── outbound encrypted WSS ──> Wan Code Relay <──> Mobile PWA / Channels
```

- `deepseek-harness/`: read-only, pinned official upstream Git submodule.
- `dsh-plugin-desktop/`: Wan Code Electron, Host/Client plugins, Windows security,
  and packaging.
- `dsh-community-fabric/`: community interoperability specification.
- `dsh-community-market/`: documentation and contract scaffold for the reviewed
  marketplace.
- Future Wan Code protocol, Relay, and PWA modules live under
  `packages/wancode/` or `apps/`.

The cloud cannot directly execute local tools or read local model credentials.
Remote commands target an explicit user, device, and session and remain
idempotent; sensitive payloads are end-to-end encrypted with device keys.

## Verify from source

Use Windows x64 with Git and Node.js `22.19+` or `24.x`:

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

Production signing uses `dist:win-release` and requires a code-signing
certificate plus `WANCODE_WINDOWS_PUBLISHER`. Signing secrets are never supplied
or committed by this repository. The release gate also requires an older trusted
installer and an explicitly disposable Windows runner, where it exercises
install, upgrade, rollback, restore, and uninstall before release.

## Upstream and license

Wan Code retains the licenses and attribution for DeepSeek Harness, Cordis, and
all third-party components. Wan Code-owned code and repository content are
licensed under the [MIT License](LICENSE). See [`UPSTREAM.md`](UPSTREAM.md) for
source provenance, pinning, and update policy.

Please report issues and suggestions through
[GitHub Issues](https://github.com/ThomasWan123/wancode-NewVer/issues).
