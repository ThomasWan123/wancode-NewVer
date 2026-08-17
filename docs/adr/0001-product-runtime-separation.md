# ADR-0001: Separate Wancode product modules from Harness Runtime

Status: accepted

## Context

Wancode needs to evolve its desktop, cloud, mobile, marketplace, and channel
features without maintaining a private fork of the Harness agent loop. The
upstream Desktop repository already isolates official source as a Git submodule
and consumes published Harness packages from an outer Yarn workspace.

## Decision

Keep `deepseek-harness/` pinned and read-only. Wancode-owned behavior is
implemented through published Cordis seams in the outer workspace. Desktop
native behavior remains in `dsh-plugin-desktop/`; cloud and PWA applications
will be separate workspace members; interoperability and marketplace contracts
remain isolated modules.

The local Host stays on loopback HTTP/WebSocket. Remote control uses an
outbound-only, authenticated, end-to-end encrypted WSS connection from Desktop
to the Wancode Relay.

## Consequences

- Upstream synchronization is explicit and mechanically reviewable.
- Wancode cannot rely on unpublished internal Harness modules.
- Product releases can pin source provenance and runtime artifacts separately.
- Cloud remote control needs its own protocol, migration, key-management, and
  compatibility test suites.
