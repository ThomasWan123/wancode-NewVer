import { describe, expect, it } from 'vitest'
import {
  validateProviderProfile,
  assertProviderProfile,
  ProviderProfileValidationError,
} from '../src/validate.ts'

function validProfile(): Record<string, unknown> {
  return {
    id: 'provider-1',
    displayName: 'Test Provider',
    endpoint: 'https://api.example.com/v1',
    capabilities: ['chat', 'completion'],
    maxConcurrentLeases: 10,
    priority: 1,
    enabled: true,
  }
}

describe('validateProviderProfile', () => {
  it('accepts a structurally valid profile', () => {
    const result = validateProviderProfile(validProfile())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.id).toBe('provider-1')
      expect(result.value.capabilities).toEqual(['chat', 'completion'])
      expect(Object.isFrozen(result.value)).toBe(true)
      expect(Object.isFrozen(result.value.capabilities)).toBe(true)
    }
  })

  it('rejects null input', () => {
    const result = validateProviderProfile(null)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations).toHaveLength(1)
      expect(result.violations[0]!.field).toBe('(root)')
    }
  })

  it('rejects array input', () => {
    const result = validateProviderProfile([])
    expect(result.ok).toBe(false)
  })

  it('rejects non-object input', () => {
    const result = validateProviderProfile('not an object')
    expect(result.ok).toBe(false)
  })

  it('rejects missing id', () => {
    const input = { ...validProfile(), id: '' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'id')).toBe(true)
    }
  })

  it('rejects id with control characters', () => {
    const input = { ...validProfile(), id: 'has\x00null' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'id' && v.message.includes('control'))).toBe(true)
    }
  })

  it('rejects oversized id', () => {
    const input = { ...validProfile(), id: 'x'.repeat(257) }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects missing displayName', () => {
    const input = { ...validProfile(), displayName: '' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'displayName')).toBe(true)
    }
  })

  it('rejects missing endpoint', () => {
    const input = { ...validProfile(), endpoint: '' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects invalid URL endpoint', () => {
    const input = { ...validProfile(), endpoint: 'not-a-url' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'endpoint' && v.message.includes('URL'))).toBe(true)
    }
  })

  it('rejects non-array capabilities', () => {
    const input = { ...validProfile(), capabilities: 'not-an-array' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects empty string capability', () => {
    const input = { ...validProfile(), capabilities: ['valid', ''] }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.some(v => v.field === 'capabilities[1]')).toBe(true)
    }
  })

  it('rejects capability with control characters', () => {
    const input = { ...validProfile(), capabilities: ['ok', 'bad\x01cap'] }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects too many capabilities', () => {
    const input = { ...validProfile(), capabilities: Array.from({ length: 129 }, (_, i) => `cap-${i}`) }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects non-number maxConcurrentLeases', () => {
    const input = { ...validProfile(), maxConcurrentLeases: '10' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects zero maxConcurrentLeases', () => {
    const input = { ...validProfile(), maxConcurrentLeases: 0 }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects fractional maxConcurrentLeases', () => {
    const input = { ...validProfile(), maxConcurrentLeases: 1.5 }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects maxConcurrentLeases above bound', () => {
    const input = { ...validProfile(), maxConcurrentLeases: 10_001 }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects non-number priority', () => {
    const input = { ...validProfile(), priority: 'high' }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects negative priority', () => {
    const input = { ...validProfile(), priority: -1 }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects Infinity priority', () => {
    const input = { ...validProfile(), priority: Infinity }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects NaN priority', () => {
    const input = { ...validProfile(), priority: NaN }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('rejects non-boolean enabled', () => {
    const input = { ...validProfile(), enabled: 1 }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(false)
  })

  it('collects multiple violations', () => {
    const result = validateProviderProfile({
      id: '',
      displayName: '',
      endpoint: '',
      capabilities: 'not-array',
      maxConcurrentLeases: 'bad',
      priority: 'bad',
      enabled: 'bad',
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.violations.length).toBeGreaterThanOrEqual(7)
    }
  })

  it('accepts zero priority', () => {
    const input = { ...validProfile(), priority: 0 }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(true)
  })

  it('accepts empty capabilities array', () => {
    const input = { ...validProfile(), capabilities: [] }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(true)
  })

  it('accepts disabled profile', () => {
    const input = { ...validProfile(), enabled: false }
    const result = validateProviderProfile(input)
    expect(result.ok).toBe(true)
  })
})

describe('assertProviderProfile', () => {
  it('returns the frozen profile for valid input', () => {
    const profile = assertProviderProfile(validProfile())
    expect(profile.id).toBe('provider-1')
    expect(Object.isFrozen(profile)).toBe(true)
  })

  it('throws ProviderProfileValidationError for invalid input', () => {
    expect(() => assertProviderProfile(null)).toThrow(ProviderProfileValidationError)
  })

  it('includes violations in the thrown error', () => {
    try {
      assertProviderProfile({ id: '' })
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderProfileValidationError)
      const typed = error as ProviderProfileValidationError
      expect(typed.violations.length).toBeGreaterThan(0)
      expect(typed.message).toContain('ProviderProfile validation failed')
    }
  })
})
