import { describe, expect, it } from 'vitest'
import {
  gateProviderProfile,
  gateProviderProfiles,
  gateAgentPrompt,
  isValidProviderProfile,
  isValidAgentPrompt,
  ProviderProfileGateError,
  PromptIntegrityGateError,
} from '../src/integrity-gate.ts'

function validProfile(): Record<string, unknown> {
  return {
    id: 'provider-1',
    displayName: 'Test Provider',
    endpoint: 'https://api.example.com/v1',
    capabilities: ['chat'],
    maxConcurrentLeases: 5,
    priority: 1,
    enabled: true,
  }
}

function validPrompt(): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    profileId: 'provider-1',
    text: 'Test prompt',
    timestamp: Date.now(),
  }
}

describe('gateProviderProfile', () => {
  it('passes valid profiles through', () => {
    const profile = gateProviderProfile(validProfile())
    expect(profile.id).toBe('provider-1')
    expect(profile.displayName).toBe('Test Provider')
  })

  it('rejects null with ProviderProfileGateError', () => {
    expect(() => gateProviderProfile(null)).toThrow(ProviderProfileGateError)
  })

  it('rejects profiles with missing required fields', () => {
    expect(() => gateProviderProfile({ id: 'x' })).toThrow(ProviderProfileGateError)
  })

  it('rejects profiles with invalid endpoint', () => {
    expect(() => gateProviderProfile({
      ...validProfile(),
      endpoint: 'not-a-url',
    })).toThrow(ProviderProfileGateError)
  })

  it('never silently coerces invalid fields', () => {
    expect(() => gateProviderProfile({
      ...validProfile(),
      maxConcurrentLeases: '10',
    })).toThrow(ProviderProfileGateError)
  })

  it('error message includes host boundary context', () => {
    try {
      gateProviderProfile(null)
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('dsh-plugin-desktop')
      expect((error as Error).message).toContain('host boundary')
    }
  })
})

describe('gateProviderProfiles (batch)', () => {
  it('passes a batch of valid profiles', () => {
    const profiles = gateProviderProfiles([
      validProfile(),
      { ...validProfile(), id: 'provider-2', displayName: 'Second' },
    ])
    expect(profiles).toHaveLength(2)
    expect(profiles[0]!.id).toBe('provider-1')
    expect(profiles[1]!.id).toBe('provider-2')
  })

  it('rejects entire batch when one profile is invalid', () => {
    expect(() => gateProviderProfiles([
      validProfile(),
      { ...validProfile(), id: '' },
    ])).toThrow(ProviderProfileGateError)
  })

  it('accepts empty batch', () => {
    const profiles = gateProviderProfiles([])
    expect(profiles).toHaveLength(0)
  })

  it('reports the index of invalid profiles', () => {
    try {
      gateProviderProfiles([
        validProfile(),
        { ...validProfile(), id: '' },
      ])
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('[1]')
    }
  })
})

describe('gateAgentPrompt', () => {
  it('passes valid prompts through', () => {
    const prompt = gateAgentPrompt(validPrompt())
    expect(prompt.sessionId).toBe('session-1')
    expect(prompt.text).toBe('Test prompt')
  })

  it('rejects null with PromptIntegrityGateError', () => {
    expect(() => gateAgentPrompt(null)).toThrow(PromptIntegrityGateError)
  })

  it('rejects prompts with empty text', () => {
    expect(() => gateAgentPrompt({
      ...validPrompt(),
      text: '',
    })).toThrow(PromptIntegrityGateError)
  })

  it('rejects prompts with missing sessionId', () => {
    const { sessionId: _, ...rest } = validPrompt()
    expect(() => gateAgentPrompt(rest)).toThrow(PromptIntegrityGateError)
  })

  it('rejects prompts with missing profileId', () => {
    const { profileId: _, ...rest } = validPrompt()
    expect(() => gateAgentPrompt(rest)).toThrow(PromptIntegrityGateError)
  })

  it('passes prompts with integrity metadata', () => {
    const prompt = gateAgentPrompt({
      ...validPrompt(),
      integrity: { checksum: 'sha256:abc', source: 'user' },
    })
    expect(prompt.integrity?.source).toBe('user')
  })

  it('rejects prompts with invalid integrity source', () => {
    expect(() => gateAgentPrompt({
      ...validPrompt(),
      integrity: { source: 'unknown' },
    })).toThrow(PromptIntegrityGateError)
  })

  it('error message includes host boundary context', () => {
    try {
      gateAgentPrompt(null)
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as Error).message).toContain('dsh-plugin-desktop')
      expect((error as Error).message).toContain('host boundary')
    }
  })
})

describe('isValidProviderProfile', () => {
  it('returns true for valid profile', () => {
    expect(isValidProviderProfile(validProfile())).toBe(true)
  })

  it('returns false for null', () => {
    expect(isValidProviderProfile(null)).toBe(false)
  })

  it('returns false for missing fields', () => {
    expect(isValidProviderProfile({ id: 'x' })).toBe(false)
  })
})

describe('isValidAgentPrompt', () => {
  it('returns true for valid prompt', () => {
    expect(isValidAgentPrompt(validPrompt())).toBe(true)
  })

  it('returns false for null', () => {
    expect(isValidAgentPrompt(null)).toBe(false)
  })

  it('returns false for empty text', () => {
    expect(isValidAgentPrompt({ ...validPrompt(), text: '' })).toBe(false)
  })
})
