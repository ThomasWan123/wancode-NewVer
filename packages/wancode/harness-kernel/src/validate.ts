/**
 * Fail-closed validation for harness-kernel contracts.
 *
 * Every validator returns a {@link ValidationResult}. Invalid inputs are
 * never coerced — callers receive a structured list of field-level
 * violations and must refuse to proceed.
 */

import type { ProviderProfile } from './provider-profile.js'

/** One field-level violation produced by a validator. */
export interface ValidationViolation {
  readonly field: string
  readonly message: string
}

/** Discriminated result: either a validated value or a non-empty violation list. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly violations: readonly ValidationViolation[] }

const MAX_ID_LENGTH = 256
const MAX_DISPLAY_NAME_LENGTH = 512
const MAX_ENDPOINT_LENGTH = 2048
const MAX_CAPABILITIES = 128
const MAX_CAPABILITY_LENGTH = 128
const MAX_CONCURRENT_LEASES = 10_000
const MAX_PRIORITY = 1_000_000

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function hasControlCharacters(value: string): boolean {
  return /[\0-\x1f\x7f]/u.test(value)
}

/**
 * Validate an untrusted value as a {@link ProviderProfile}.
 *
 * Rejects missing required fields, out-of-range numbers, control
 * characters in string fields, and structurally invalid capability
 * arrays. Never coerces — invalid input produces violations.
 */
export function validateProviderProfile(input: unknown): ValidationResult<ProviderProfile> {
  const violations: ValidationViolation[] = []
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, violations: [{ field: '(root)', message: 'must be a plain object' }] }
  }
  const record = input as Record<string, unknown>

  if (!isNonEmptyString(record.id)) {
    violations.push({ field: 'id', message: 'must be a non-empty string' })
  } else if (record.id.length > MAX_ID_LENGTH) {
    violations.push({ field: 'id', message: `must not exceed ${MAX_ID_LENGTH} characters` })
  } else if (hasControlCharacters(record.id)) {
    violations.push({ field: 'id', message: 'must not contain control characters' })
  }

  if (!isNonEmptyString(record.displayName)) {
    violations.push({ field: 'displayName', message: 'must be a non-empty string' })
  } else if (record.displayName.length > MAX_DISPLAY_NAME_LENGTH) {
    violations.push({ field: 'displayName', message: `must not exceed ${MAX_DISPLAY_NAME_LENGTH} characters` })
  }

  if (!isNonEmptyString(record.endpoint)) {
    violations.push({ field: 'endpoint', message: 'must be a non-empty string' })
  } else if (record.endpoint.length > MAX_ENDPOINT_LENGTH) {
    violations.push({ field: 'endpoint', message: `must not exceed ${MAX_ENDPOINT_LENGTH} characters` })
  } else {
    try {
      new URL(record.endpoint)
    } catch {
      violations.push({ field: 'endpoint', message: 'must be a valid URL' })
    }
  }

  if (!Array.isArray(record.capabilities)) {
    violations.push({ field: 'capabilities', message: 'must be an array' })
  } else {
    if (record.capabilities.length > MAX_CAPABILITIES) {
      violations.push({ field: 'capabilities', message: `must not exceed ${MAX_CAPABILITIES} entries` })
    }
    for (let i = 0; i < record.capabilities.length; i++) {
      const cap = record.capabilities[i]
      if (typeof cap !== 'string' || cap.length === 0) {
        violations.push({ field: `capabilities[${i}]`, message: 'must be a non-empty string' })
      } else if (cap.length > MAX_CAPABILITY_LENGTH) {
        violations.push({ field: `capabilities[${i}]`, message: `must not exceed ${MAX_CAPABILITY_LENGTH} characters` })
      } else if (hasControlCharacters(cap)) {
        violations.push({ field: `capabilities[${i}]`, message: 'must not contain control characters' })
      }
    }
  }

  if (typeof record.maxConcurrentLeases !== 'number') {
    violations.push({ field: 'maxConcurrentLeases', message: 'must be a number' })
  } else if (!Number.isInteger(record.maxConcurrentLeases) || record.maxConcurrentLeases < 1) {
    violations.push({ field: 'maxConcurrentLeases', message: 'must be a positive integer' })
  } else if (record.maxConcurrentLeases > MAX_CONCURRENT_LEASES) {
    violations.push({ field: 'maxConcurrentLeases', message: `must not exceed ${MAX_CONCURRENT_LEASES}` })
  }

  if (typeof record.priority !== 'number') {
    violations.push({ field: 'priority', message: 'must be a number' })
  } else if (!Number.isFinite(record.priority)) {
    violations.push({ field: 'priority', message: 'must be a finite number' })
  } else if (record.priority < 0 || record.priority > MAX_PRIORITY) {
    violations.push({ field: 'priority', message: `must be between 0 and ${MAX_PRIORITY}` })
  }

  if (typeof record.enabled !== 'boolean') {
    violations.push({ field: 'enabled', message: 'must be a boolean' })
  }

  if (violations.length > 0) {
    return { ok: false, violations }
  }

  return {
    ok: true,
    value: Object.freeze({
      id: record.id as string,
      displayName: record.displayName as string,
      endpoint: record.endpoint as string,
      capabilities: Object.freeze([...(record.capabilities as string[])]),
      maxConcurrentLeases: record.maxConcurrentLeases as number,
      priority: record.priority as number,
      enabled: record.enabled as boolean,
    }),
  }
}

/**
 * Assert that `input` is a valid {@link ProviderProfile}, throwing on
 * any violation. Convenience wrapper for call sites that want fail-closed
 * semantics without inspecting the result discriminant.
 */
export function assertProviderProfile(input: unknown): ProviderProfile {
  const result = validateProviderProfile(input)
  if (!result.ok) {
    const summary = result.violations.map(v => `${v.field}: ${v.message}`).join('; ')
    throw new ProviderProfileValidationError(summary, result.violations)
  }
  return result.value
}

/** Structured error thrown by {@link assertProviderProfile}. */
export class ProviderProfileValidationError extends Error {
  readonly violations: readonly ValidationViolation[]
  constructor(message: string, violations: readonly ValidationViolation[]) {
    super(`ProviderProfile validation failed: ${message}`)
    this.name = 'ProviderProfileValidationError'
    this.violations = violations
  }
}
