# ADR-0003: Append-only session ledger with evidence scrub

## Status

Accepted (Slice 3)

## Context

WanCode issue #75 requires an audit trail for session activity: which
probes ran, which gates passed or rejected, and what tools and approvals
were invoked. The evidence must be append-only (no retroactive edits),
must scrub secrets so raw tokens never appear in ledger fields, and must
mark skipped probes as NOT-RUN rather than success to prevent false
assurance.

Slice 2 established fail-closed integrity gates at the desktop host
boundary. Slice 3 extends the kernel with a session ledger that records
observable state transitions at those gates and other host seams.

## Decision

### Kernel layer (`@wancode/harness-kernel`)

Extend the existing `LedgerEvent` type stubs with:

- Additional event kinds for session lifecycle, integrity outcomes,
  tool invocations, approval decisions, and NOT-RUN probes.
- A `ProbeOutcome` type (`'pass' | 'fail' | 'not-run'`) enforced by
  `createNotRunEvent` to prevent skipped probes from recording success.
- `scrubSecrets` / `scrubMetadata` pure functions that redact
  secret-shaped tokens (API keys, JWTs, GitHub PATs, Slack tokens,
  AWS key IDs, base64 blobs) from string values before storage.
- `createLedgerEvent` factory that freezes events and scrubs metadata
  automatically.
- `createSessionLedger` in-memory append-only store that enforces
  monotonically non-decreasing timestamps, unique event ids, and
  frozen events.

The kernel layer has no Electron, Cordis, or platform dependencies.

### Desktop adapter (`dsh-plugin-desktop/session-ledger`)

A thin adapter that wraps the kernel ledger with typed recording
methods for each discoverable host seam:

- Session start/end (host boot/shutdown)
- Integrity gate pass/reject (via `observeIntegrityGate` wrapper)
- Tool invocations and results
- Approval requests, grants, and denials
- NOT-RUN probes

The adapter does not add Cordis service requirements, does not modify
the relay pipeline, and does not require graphical application launch.

### Scrubbing contract

All metadata passes through `scrubMetadata` before the event is frozen.
The scrubbing layer uses a fixed set of regular expressions covering
common secret formats. Tests verify fail-closed behavior: raw tokens
must not appear in any serialized event.

## Consequences

- The session ledger is available for consumption at profile
  composition, relay entry points, and future Cordis service faces.
- Audit trails distinguish between probes that passed, failed, and
  were never executed.
- Secret scrubbing applies uniformly to all event types including
  NOT-RUN probes and integrity rejections.
- The in-memory ledger is suitable for single-process desktop sessions.
  File-backed or distributed ledger backends can implement the same
  `SessionLedger` interface in future slices.
- No runtime kernel scheduler or lease system ships with this slice.
  Lease events remain in the `LedgerEventKind` union for forward
  compatibility.
