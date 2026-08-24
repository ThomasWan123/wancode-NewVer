# ADR-0002: Harness-kernel type stubs and validation

## Status

Accepted (Slice 0 — types; Slice 2 — fail-closed validation; Slice 3 — session ledger)

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

Slice 2 extends the package with fail-closed validation for
`ProviderProfile` and `AgentPrompt` payloads at the desktop host
boundary, ensuring invalid data is rejected — never silently coerced.

## Decision

Add a private `@wancode/harness-kernel` package under
`packages/wancode/harness-kernel/` containing TypeScript type
exports (`ProviderProfile`, `Lease`, `LedgerEvent`, and supporting
literal types) plus pure validation functions.

The package:

- Is `private: true` and is NOT registered as a Cordis plugin (no `dsh`
  field in package.json).
- Exports types and pure validation functions with no Electron, Cordis,
  or platform dependencies — testable in any Node.js environment.
- Lives inside the `packages/wancode/*` glob already in the root
  workspace, so Yarn resolves it without configuration changes.
- Passes the `verify-layout` gate because it carries the `@wancode/`
  scope and declares no `dsh` entry.

### Slice 2 additions

- `validateProviderProfile` / `assertProviderProfile` — structured
  validation returning `ValidationResult<ProviderProfile>` or throwing
  `ProviderProfileValidationError`.
- `validateAgentPrompt` / `assertPromptIntegrity` — prompt integrity
  gate returning `ValidationResult<AgentPrompt>` or throwing
  `PromptIntegrityError`.
- `dsh-plugin-desktop/integrity-gate` — host-boundary wrappers that
  translate kernel validation errors into desktop-prefixed gate errors,
  consumed at profile composition and relay-mail entry points.

## Consequences

- Other workspace packages can `import type { Lease } from '@wancode/harness-kernel'`
  today and get compile-time feedback on contract drift.
- `dsh-plugin-desktop` can gate untrusted profiles and prompts at its
  host boundary using pure functions from the kernel package.
- Validated values are frozen to prevent downstream mutation.
- Slice 3 extends the package with an append-only session ledger,
  secret scrubbing, and NOT-RUN probe evidence (see ADR-0003).
- No runtime kernel scheduler ships until an implementation ADR for
  Slice 4 is accepted.
- The package must remain `private` and non-loadable until the kernel
  runtime, a Cordis service face, and a reviewed lease-scheduler exist.
