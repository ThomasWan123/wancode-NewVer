/**
 * Fail-closed integrity gate for the desktop host boundary.
 *
 * Validates {@link ProviderProfile} and {@link AgentPrompt} payloads
 * before they cross into the Cordis host or reach a provider.
 * Invalid payloads are rejected with structured errors — never silently
 * coerced.
 */

import {
  assertProviderProfile,
  assertPromptIntegrity,
  ProviderProfileValidationError,
  PromptIntegrityError,
  validateProviderProfile,
  validateAgentPrompt,
  type ProviderProfile,
  type AgentPrompt,
} from '@wancode/harness-kernel'

const GATE_PREFIX = 'dsh-plugin-desktop'

/**
 * Gate a provider profile at the host boundary. Returns the validated
 * profile or throws a {@link ProviderProfileGateError}.
 */
export function gateProviderProfile(input: unknown): ProviderProfile {
  try {
    return assertProviderProfile(input)
  } catch (cause) {
    if (cause instanceof ProviderProfileValidationError) {
      throw new ProviderProfileGateError(cause.message, cause)
    }
    throw cause
  }
}

/**
 * Gate a batch of provider profiles. Rejects the entire batch if any
 * profile is invalid — no partial acceptance.
 */
export function gateProviderProfiles(inputs: readonly unknown[]): readonly ProviderProfile[] {
  const results: ProviderProfile[] = []
  const errors: string[] = []
  for (let i = 0; i < inputs.length; i++) {
    const result = validateProviderProfile(inputs[i])
    if (result.ok) {
      results.push(result.value)
    } else {
      const summary = result.violations.map(v => `${v.field}: ${v.message}`).join('; ')
      errors.push(`[${i}]: ${summary}`)
    }
  }
  if (errors.length > 0) {
    throw new ProviderProfileGateError(
      `${GATE_PREFIX}: ${errors.length} profile(s) failed validation: ${errors.join(' | ')}`,
    )
  }
  return Object.freeze(results)
}

/**
 * Gate an agent prompt at the host boundary before it can reach a
 * provider. Returns the validated prompt or throws a
 * {@link PromptIntegrityGateError}.
 */
export function gateAgentPrompt(input: unknown): AgentPrompt {
  try {
    return assertPromptIntegrity(input)
  } catch (cause) {
    if (cause instanceof PromptIntegrityError) {
      throw new PromptIntegrityGateError(cause.message, cause)
    }
    throw cause
  }
}

/**
 * Check whether an untrusted value would pass the provider profile gate
 * without throwing.
 */
export function isValidProviderProfile(input: unknown): input is ProviderProfile {
  return validateProviderProfile(input).ok
}

/**
 * Check whether an untrusted value would pass the prompt integrity gate
 * without throwing.
 */
export function isValidAgentPrompt(input: unknown): input is AgentPrompt {
  return validateAgentPrompt(input).ok
}

/** Host-boundary error for rejected provider profiles. */
export class ProviderProfileGateError extends Error {
  constructor(message: string, cause?: Error) {
    super(`${GATE_PREFIX}: provider profile rejected at host boundary: ${message}`)
    this.name = 'ProviderProfileGateError'
    if (cause !== undefined) this.cause = cause
  }
}

/** Host-boundary error for rejected prompts. */
export class PromptIntegrityGateError extends Error {
  constructor(message: string, cause?: Error) {
    super(`${GATE_PREFIX}: prompt rejected at host boundary: ${message}`)
    this.name = 'PromptIntegrityGateError'
    if (cause !== undefined) this.cause = cause
  }
}
