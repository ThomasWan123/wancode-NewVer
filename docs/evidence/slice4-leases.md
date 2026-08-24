# Slice 4 — Leases + duplicate-owner protect

## What was implemented

### Lease manager (`@wancode/harness-kernel/lease`)

A pure, platform-independent lease system managing time-bounded,
owner-exclusive resource allocations:

| Component | Description |
| --- | --- |
| `LeaseState` | `'pending' \| 'active' \| 'released' \| 'expired' \| 'denied'` |
| `LeaseResourceKind` | `'tool' \| 'session' \| 'subagent'` |
| `Lease` | Frozen record with id, resourceId, resourceKind, ownerId, state, timestamps |
| `LeaseAcquireRequest` | Input for acquire: id, resourceId, resourceKind, ownerId, durationMs, now |
| `LeaseAcquireResult` | `{ ok: true, lease }` or `{ ok: false, reason, holder? }` |
| `LeaseDenyReason` | `'duplicate-owner' \| 'resource-held'` |
| `LeaseReleaseRequest` | Input for release: leaseId, ownerId, now |
| `LeaseReleaseResult` | `{ ok: true, lease }` or `{ ok: false, reason }` |
| `LeaseManager` | Interface: acquire, release, expireAll, get, activeForResource, allActive, allHeldBy |
| `createLeaseManager()` | Pure factory returning a `LeaseManager` instance |
| `LeaseError` | Structured error for invalid acquire inputs |

### Ledger event kinds updated

Replaced the forward-compatible stubs with actionable event kinds:

| Old (stub) | New (active) |
| --- | --- |
| `lease.created` | `lease.acquired` |
| `lease.activated` | _(merged into acquired)_ |
| `lease.completed` | `lease.released` |
| `lease.cancelled` | `lease.denied` |
| `lease.expired` | `lease.expired` (unchanged) |

### Desktop lease adapter (`dsh-plugin-desktop/lease-adapter`)

Wires the kernel LeaseManager to real desktop host seams with ledger
integration:

| Seam | Method |
| --- | --- |
| Tool acquire | `acquireTool({ toolId, ownerId, sessionId, durationMs? })` |
| Session acquire | `acquireSession({ sessionId, ownerId, durationMs? })` |
| Normal release | `release({ leaseId, ownerId, sessionId })` |
| Owner terminated | `releaseAllForOwner({ ownerId, sessionId, reason })` |
| Stale expiry | `expireStale(sessionId)` |
| Shutdown kill | `compensatingShutdown({ sessionId, reason })` |

Each operation records the corresponding ledger event (`lease.acquired`,
`lease.released`, `lease.denied`, `lease.expired`) with metadata
including compensating flags and reasons.

### Fail-closed guarantees

- **Duplicate-owner reject**: A second acquire by the same owner on the
  same resource returns `{ ok: false, reason: 'duplicate-owner' }`.
- **Resource-held reject**: A different owner attempting to acquire a
  held resource returns `{ ok: false, reason: 'resource-held' }`.
- **Owner verification on release**: Only the recorded owner can release
  a lease; impersonation returns `{ ok: false, reason: 'not-owner' }`.
- **Compensating shutdown**: All active leases are forcibly released on
  application shutdown/terminal paths.
- **Frozen leases**: All `Lease` records are `Object.freeze`d.

## Seams chosen

1. **`@wancode/harness-kernel/lease`** — pure functions and state, no
   Electron/Cordis/platform dependencies. Testable in any Node.js env.
2. **`dsh-plugin-desktop/lease-adapter`** — desktop adapter exported
   from the plugin package. Wires the manager to real host seams and
   records events to the Slice 3 session ledger.
3. **Shutdown path** — `compensatingShutdown` releases all held leases
   on SIGTERM, SIGINT, and Electron before-quit.
4. **Owner termination** — `releaseAllForOwner` compensates when an
   agent or session terminates unexpectedly.

## What was NOT changed

- Relay (`relay.ts`) is not modified.
- No Cordis service face or inject was added.
- Upstream submodule pin is unchanged.
- Approvals UX (Slice 5 scope) is not included.

## How to re-run tests

```bash
# Harness-kernel unit tests (133 tests)
yarn workspace @wancode/harness-kernel test

# Desktop lease adapter tests (23 tests)
yarn workspace dsh-plugin-desktop vitest run tests/lease-adapter.spec.ts

# Full desktop test suite (confirms no regressions)
yarn workspace dsh-plugin-desktop test

# Typecheck (all configs)
yarn workspace @wancode/harness-kernel typecheck
yarn workspace dsh-plugin-desktop typecheck

# Layout gate
yarn check:layout
```

## Test counts

| Suite | Tests |
| --- | --- |
| `@wancode/harness-kernel` (all) | 133 |
| `harness-kernel/lease.spec.ts` | 36 |
| `dsh-plugin-desktop/lease-adapter.spec.ts` | 23 |
| `dsh-plugin-desktop` (all) | 501 passed, 1 pre-existing Windows-only skip |

## Known pre-existing skip

`tests/verify-win-lifecycle.spec.ts` fails on Linux because it tests
Windows-specific path resolution. This failure exists on the base
branch and is unrelated to Slice 4.
