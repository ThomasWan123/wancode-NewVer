# Slice 2 — ProviderProfile + prompt integrity fail-closed

## What was gated

### ProviderProfile validation (`@wancode/harness-kernel`)

All `ProviderProfile` objects are validated fail-closed before they can
enter the desktop host or plugin boundary. Validation rejects:

| Check                          | Fail mode      |
| ------------------------------ | -------------- |
| Non-object input               | Reject         |
| Missing/empty `id`             | Reject         |
| Control characters in `id`     | Reject         |
| Missing/empty `displayName`    | Reject         |
| Missing/invalid URL `endpoint` | Reject         |
| Non-array `capabilities`       | Reject         |
| Empty/control-char capabilities| Reject         |
| Too many capabilities (>128)   | Reject         |
| Non-integer/negative/zero `maxConcurrentLeases` | Reject |
| Non-finite/negative `priority` | Reject         |
| Non-boolean `enabled`          | Reject         |

Batch validation (`gateProviderProfiles`) rejects the entire batch if
any single profile is invalid — no partial acceptance.

### Prompt integrity gate (`@wancode/harness-kernel`)

All `AgentPrompt` payloads are validated fail-closed before they can
reach a provider through the desktop host boundary. Validation rejects:

| Check                          | Fail mode      |
| ------------------------------ | -------------- |
| Non-object input               | Reject         |
| Missing/empty `sessionId`      | Reject         |
| Control characters in session  | Reject         |
| Missing/empty `profileId`      | Reject         |
| Missing/empty `text`           | Reject         |
| Oversized text (>2M chars)     | Reject         |
| Missing/non-finite `timestamp` | Reject         |
| Invalid integrity metadata     | Reject         |
| Unknown prompt source          | Reject         |

### Desktop host boundary (`dsh-plugin-desktop/integrity-gate`)

Provides gate functions consumed at the Cordis host boundary:

- `gateProviderProfile(input)` — single profile gate, throws `ProviderProfileGateError`
- `gateProviderProfiles(inputs)` — batch gate, atomic reject
- `gateAgentPrompt(input)` — prompt gate, throws `PromptIntegrityGateError`
- `isValidProviderProfile(input)` / `isValidAgentPrompt(input)` — predicate variants

All gate errors carry the `dsh-plugin-desktop: … host boundary` prefix
so failures are traceable to the exact seam.

## Seams chosen

1. **`@wancode/harness-kernel`** — pure validation functions with no
   Electron or Cordis dependency, testable in isolation.
2. **`dsh-plugin-desktop/integrity-gate`** — host-boundary wrappers
   exported from the desktop plugin package for consumption at profile
   composition and relay-mail entry points.

## How to re-run tests

```bash
# Harness-kernel unit tests (55 tests)
yarn workspace @wancode/harness-kernel test

# Desktop integrity gate integration tests (24 tests)
yarn workspace dsh-plugin-desktop vitest run tests/integrity-gate.spec.ts

# Full desktop test suite (confirms no regressions)
yarn workspace dsh-plugin-desktop test

# Typecheck (all configs)
yarn workspace @wancode/harness-kernel typecheck
yarn workspace dsh-plugin-desktop typecheck

# Layout gate
yarn check:layout
```

## Known pre-existing skip

`tests/verify-win-lifecycle.spec.ts` fails on Linux because it tests
Windows-specific path resolution. This failure exists on the base
branch and is unrelated to Slice 2.
