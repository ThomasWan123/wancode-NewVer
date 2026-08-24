# ADR-0002: Harness-kernel type stubs

## Status

Accepted (Slice 0 — types only, non-loadable)

## Context

WanCode issue #75 proposes a provider-scheduling kernel that manages
lease-based access to model backends. The kernel must eventually:

1. Accept `ProviderProfile` registrations at runtime.
2. Issue time-bounded `Lease` objects against provider capacity.
3. Emit append-only `LedgerEvent` records for billing and audit.

Before implementing any runtime behavior, the type contracts need to
exist in the workspace so that downstream packages (relay-protocol,
desktop plugin, future market adapters) can program against stable
interfaces during parallel development.

## Decision

Add a private `@wancode/harness-kernel` package under
`packages/wancode/harness-kernel/` containing only TypeScript type
exports (`ProviderProfile`, `Lease`, `LedgerEvent`, and supporting
literal types).

The package:

- Is `private: true` and is NOT registered as a Cordis plugin (no `dsh`
  field in package.json).
- Exports only types; there is no runtime JavaScript.
- Lives inside the `packages/wancode/*` glob already in the root
  workspace, so Yarn resolves it without configuration changes.
- Passes the `verify-layout` gate because it carries the `@wancode/`
  scope and declares no `dsh` entry.

## Consequences

- Other workspace packages can `import type { Lease } from '@wancode/harness-kernel'`
  today and get compile-time feedback on contract drift.
- No runtime code ships until an implementation ADR is accepted.
- The package must remain `private` and non-loadable until the kernel
  runtime, a Cordis service face, and a reviewed lease-scheduler exist.
