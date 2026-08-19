# DSH Desktop repository rules

This repository owns the desktop product around an unmodified DeepSeek Harness checkout.

- `deepseek-harness/` is a pinned upstream Git submodule. Never edit files inside it from a desktop feature branch.
- `dsh-plugin-desktop/` owns the Cordis Host and Client faces, Electron bootstrap, packaging, and release tests.
- `packages/wancode/` owns Wan Code protocol, cloud, and mobile PWA modules. `@wancode/relay-protocol` is the fail-closed remote-control contract and outbound-only WebSocket dialer. It must not declare a loadable DSH plugin entry or listen on a public interface. `@wancode/relay-pwa` is the mobile pairing and session-projection surface. It must not declare a loadable DSH plugin entry, listen on a public interface, store model credentials, or depend on `@wancode/*` through `workspace:` ranges.
- `dsh-community-fabric/` owns the community interoperability RFC. Until schemas and a reviewed reference adapter exist, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- `dsh-community-market/` owns the community-market shell. Until its runtime is implemented, it remains a private documentation scaffold and must not declare loadable DSH or package entry points.
- The outer repository and all owned packages use the root Yarn release with `nodeLinker: node-modules`.
- The upstream submodule keeps its own pnpm workspace. Run upstream commands through the root `upstream:*` scripts, whose Yarn portable-shell commands enter the submodule before invoking Corepack.
- Compatibility mode must run the upstream default client without layout, slot, or service overrides. The desktop Client may restyle upstream DeepSeek wordmarks and visible DeepSeek product copy to Wan Code in both modes. Advanced presentation belongs to desktop-owned client plugins and may replace documented slots or services through profile composition.
- Keep graphical application launch explicit. Builds, typechecks, unit tests, and Loader smokes must remain headless-safe.
- Commit before major changes of direction and keep the submodule pin update separate from desktop behavior changes.
- Keep the repository topology and package-manager split consistent with the [owning Agent Note](.agents/notes/implemented/process/2026-08-15-pinned-upstream-and-isolated-yarn-workspace.md).
