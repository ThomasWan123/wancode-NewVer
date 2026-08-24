/**
 * Prompt-integrity gate for the harness kernel.
 *
 * Before an agent prompt is forwarded to a provider, the desktop host
 * must verify that the prompt satisfies structural integrity constraints.
 * The gate is fail-closed: any violation blocks the prompt from
 * proceeding to the provider.
 */

import type { ValidationViolation, ValidationResult } from './validate.js'

/** Prompt payload entering the desktop host boundary. */
export interface AgentPrompt {
  readonly sessionId: string
  readonly profileId: string
  readonly text: string
  readonly timestamp: number
  readonly integrity?: PromptIntegrityMeta
}

/** Optional integrity metadata attached by the sender. */
export interface PromptIntegrityMeta {
  readonly checksum?: string
  readonly source?: PromptSource
}

/** Origin classification for a prompt. */
export type PromptSource = 'user' | 'agent' | 'system' | 'relay'

const MAX_TEXT_LENGTH = 2_000_000
const MAX_SESSION_ID_LENGTH = 256
const MAX_PROFILE_ID_LENGTH = 256
const SUPPORTED_SOURCES: readonly PromptSource[] = ['user', 'agent', 'system', 'relay']

/**
 * Validate a prompt before it enters the provider boundary.
 *
 * Rejects empty text, missing session/profile ids, timestamps in the
 * future, and malformed integrity metadata. Never coerces.
 */
export function validateAgentPrompt(input: unknown): ValidationResult<AgentPrompt> {
  const violations: ValidationViolation[] = []

  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, violations: [{ field: '(root)', message: 'must be a plain object' }] }
  }
  const record = input as Record<string, unknown>

  if (typeof record.sessionId !== 'string' || record.sessionId.length === 0) {
    violations.push({ field: 'sessionId', message: 'must be a non-empty string' })
  } else if (record.sessionId.length > MAX_SESSION_ID_LENGTH) {
    violations.push({ field: 'sessionId', message: `must not exceed ${MAX_SESSION_ID_LENGTH} characters` })
  } else if (/[\0\r\n]/u.test(record.sessionId)) {
    violations.push({ field: 'sessionId', message: 'must not contain control characters' })
  }

  if (typeof record.profileId !== 'string' || record.profileId.length === 0) {
    violations.push({ field: 'profileId', message: 'must be a non-empty string' })
  } else if (record.profileId.length > MAX_PROFILE_ID_LENGTH) {
    violations.push({ field: 'profileId', message: `must not exceed ${MAX_PROFILE_ID_LENGTH} characters` })
  } else if (/[\0\r\n]/u.test(record.profileId)) {
    violations.push({ field: 'profileId', message: 'must not contain control characters' })
  }

  if (typeof record.text !== 'string') {
    violations.push({ field: 'text', message: 'must be a string' })
  } else if (record.text.length === 0) {
    violations.push({ field: 'text', message: 'must not be empty' })
  } else if (record.text.length > MAX_TEXT_LENGTH) {
    violations.push({ field: 'text', message: `must not exceed ${MAX_TEXT_LENGTH} characters` })
  }

  if (typeof record.timestamp !== 'number') {
    violations.push({ field: 'timestamp', message: 'must be a number' })
  } else if (!Number.isFinite(record.timestamp) || record.timestamp <= 0) {
    violations.push({ field: 'timestamp', message: 'must be a positive finite number' })
  }

  if (record.integrity !== undefined) {
    if (typeof record.integrity !== 'object' || record.integrity === null || Array.isArray(record.integrity)) {
      violations.push({ field: 'integrity', message: 'must be a plain object when present' })
    } else {
      const meta = record.integrity as Record<string, unknown>
      if (meta.checksum !== undefined) {
        if (typeof meta.checksum !== 'string' || meta.checksum.length === 0) {
          violations.push({ field: 'integrity.checksum', message: 'must be a non-empty string when present' })
        }
      }
      if (meta.source !== undefined) {
        if (typeof meta.source !== 'string' || !(SUPPORTED_SOURCES as readonly string[]).includes(meta.source)) {
          violations.push({ field: 'integrity.source', message: `must be one of: ${SUPPORTED_SOURCES.join(', ')}` })
        }
      }
    }
  }

  if (violations.length > 0) {
    return { ok: false, violations }
  }

  const integrityMeta: PromptIntegrityMeta | undefined =
    record.integrity !== undefined
      ? Object.freeze({
          ...((record.integrity as Record<string, unknown>).checksum !== undefined
            ? { checksum: (record.integrity as Record<string, unknown>).checksum as string }
            : {}),
          ...((record.integrity as Record<string, unknown>).source !== undefined
            ? { source: (record.integrity as Record<string, unknown>).source as PromptSource }
            : {}),
        })
      : undefined

  return {
    ok: true,
    value: Object.freeze({
      sessionId: record.sessionId as string,
      profileId: record.profileId as string,
      text: record.text as string,
      timestamp: record.timestamp as number,
      ...(integrityMeta !== undefined ? { integrity: integrityMeta } : {}),
    }),
  }
}

/**
 * Assert that a prompt passes the integrity gate, throwing on any
 * violation. Fail-closed: invalid prompts must never reach the provider.
 */
export function assertPromptIntegrity(input: unknown): AgentPrompt {
  const result = validateAgentPrompt(input)
  if (!result.ok) {
    const summary = result.violations.map(v => `${v.field}: ${v.message}`).join('; ')
    throw new PromptIntegrityError(summary, result.violations)
  }
  return result.value
}

/** Structured error thrown by {@link assertPromptIntegrity}. */
export class PromptIntegrityError extends Error {
  readonly violations: readonly ValidationViolation[]
  constructor(message: string, violations: readonly ValidationViolation[]) {
    super(`Prompt integrity gate failed: ${message}`)
    this.name = 'PromptIntegrityError'
    this.violations = violations
  }
}
