# Upstream policy

## Product name

The user-facing product name is **WanCodeNewVer**. The GitHub repository
slug is `wancode-NewVer` (may be renamed to `WanCodeNewVer` by the owner).
The `appId` remains `com.wancode.desktop` to preserve update continuity
and existing installer registrations on Windows.

## Sources

- Product baseline: `https://github.com/anywhere-labs/deepseek-harness-desktop`
- Harness source: `https://github.com/deepseek-ai/deepseek-harness`
- Harness source pin and runtime family: `upstream.json`

The remotes are named:

- `origin`: `https://github.com/ThomasWan123/wancode-NewVer`
- `desktop-upstream`: the product baseline
- `harness-upstream`: the official Harness repository

## Ownership

`deepseek-harness/` is a read-only Git submodule. Wancode changes belong in the
outer Yarn workspace. A change that appears to require editing the submodule
must first be redesigned against a published Harness seam or proposed upstream.

## Update procedure

1. Fetch both upstream remotes.
2. Review Desktop baseline changes separately from the official Harness pin.
3. Update the submodule gitlink and `upstream.json` in an isolated change.
4. Update published `@deepseek-ai/dsh*` runtime versions separately when the npm
   family has no verifiable matching source commit.
5. Run layout, upstream version, immutable install, build, typecheck, unit,
   package, migration, and protocol compatibility gates.
6. Record the verified source commit, runtime family, Wancode commit, protocol
   version, and migration version in release metadata.

Never automatically release from an upstream branch or silently rewrite user
data during an upstream update.
