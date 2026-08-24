import { describe, expect, it } from 'vitest'
import {
  validateAgentPrompt,
  assertPromptIntegrity,
  PromptIntegrityError,
} from '../src/prompt-integrity.ts'

function validPrompt(): Record<string, unknown> {
  return {
    sessionId: 'session-abc',
    profileId: 'provider-1',
    text: 'Hello, world!',
    timestamp: Date.now(),
  }
}

describe('validateAgentPrompt', () => {
  it('accepts a structurally valid prompt without integrity metadata', () => {
    const result = validateAgentPrompt(validPrompt())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.sessionId).toBe('session-abc')
      expect(result.value.text).toBe('Hello, world!')
      expect(result.value.integrity).toBeUndefined()
      expect(Object.isFrozen(result.value)).toBe(true)
    }
  })

  it('accepts a prompt with integrity metadata', () => {
    const result = validateAgentPrompt({
      ...validPrompt(),
      integrity: { checksum: 'sha256:abc123', source: 'user' },
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.integrity?.checksum).toBe('sha256:abc123')
      expect(result.value.integrity?.source).toBe('user')
    }
  })

  it('accepts all supported prompt sources', () => {
    for (const source of ['user', 'agent', 'system', 'relay'] as const) {
      const result = validateAgentPrompt({
        ...validPrompt(),
        integrity: { source },
      })
      expect(result.ok).toBe(true)
    }
  })

  it('rejects null input', () => {
    const result = validateAgentPrompt(null)
    expect(result.ok).toBe(false)
  })

  it('rejects array input', () => {
    const result = validateAgentPrompt([])
    expect(result.ok).toBe(false)
  })

  it('rejects missing sessionId', () => {
    const { sessionId: _, ...rest } = validPrompt()
    const result = validateAgentPrompt(rest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'sessionId')).toBe(true)
    }
  })

  it('rejects empty sessionId', () => {
    const result = validateAgentPrompt({ ...validPrompt(), sessionId: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects sessionId with control characters', () => {
    const result = validateAgentPrompt({ ...validPrompt(), sessionId: 'has\x00null' })
    expect(result.ok).toBe(false)
  })

  it('rejects oversized sessionId', () => {
    const result = validateAgentPrompt({ ...validPrompt(), sessionId: 'x'.repeat(257) })
    expect(result.ok).toBe(false)
  })

  it('rejects missing profileId', () => {
    const { profileId: _, ...rest } = validPrompt()
    const result = validateAgentPrompt(rest)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'profileId')).toBe(true)
    }
  })

  it('rejects empty profileId', () => {
    const result = validateAgentPrompt({ ...validPrompt(), profileId: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects missing text', () => {
    const { text: _, ...rest } = validPrompt()
    const result = validateAgentPrompt(rest)
    expect(result.ok).toBe(false)
  })

  it('rejects empty text', () => {
    const result = validateAgentPrompt({ ...validPrompt(), text: '' })
    expect(result.ok).toBe(false)
  })

  it('rejects oversized text', () => {
    const result = validateAgentPrompt({ ...validPrompt(), text: 'x'.repeat(2_000_001) })
    expect(result.ok).toBe(false)
  })

  it('rejects missing timestamp', () => {
    const { timestamp: _, ...rest } = validPrompt()
    const result = validateAgentPrompt(rest)
    expect(result.ok).toBe(false)
  })

  it('rejects zero timestamp', () => {
    const result = validateAgentPrompt({ ...validPrompt(), timestamp: 0 })
    expect(result.ok).toBe(false)
  })

  it('rejects negative timestamp', () => {
    const result = validateAgentPrompt({ ...validPrompt(), timestamp: -1 })
    expect(result.ok).toBe(false)
  })

  it('rejects NaN timestamp', () => {
    const result = validateAgentPrompt({ ...validPrompt(), timestamp: NaN })
    expect(result.ok).toBe(false)
  })

  it('rejects non-object integrity metadata', () => {
    const result = validateAgentPrompt({ ...validPrompt(), integrity: 'bad' })
    expect(result.ok).toBe(false)
  })

  it('rejects empty checksum', () => {
    const result = validateAgentPrompt({
      ...validPrompt(),
      integrity: { checksum: '' },
    })
    expect(result.ok).toBe(false)
  })

  it('rejects unknown prompt source', () => {
    const result = validateAgentPrompt({
      ...validPrompt(),
      integrity: { source: 'unknown' },
    })
    expect(result.ok).toBe(false)
  })

  it('collects multiple violations', () => {
    const result = validateAgentPrompt({
      sessionId: '',
      profileId: '',
      text: '',
      timestamp: -1,
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.length).toBeGreaterThanOrEqual(4)
    }
  })
})

describe('assertPromptIntegrity', () => {
  it('returns the frozen prompt for valid input', () => {
    const prompt = assertPromptIntegrity(validPrompt())
    expect(prompt.sessionId).toBe('session-abc')
    expect(Object.isFrozen(prompt)).toBe(true)
  })

  it('throws PromptIntegrityError for invalid input', () => {
    expect(() => assertPromptIntegrity(null)).toThrow(PromptIntegrityError)
  })

  it('includes violations in the thrown error', () => {
    try {
      assertPromptIntegrity({ text: '' })
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(PromptIntegrityError)
      const typed = error as PromptIntegrityError
      expect(typed.violations.length).toBeGreaterThan(0)
      expect(typed.message).toContain('Prompt integrity gate failed')
    }
  })
})
