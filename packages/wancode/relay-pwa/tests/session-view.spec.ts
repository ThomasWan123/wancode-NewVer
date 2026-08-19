import { describe, expect, it } from 'vitest'
import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import { projectRelaySessionView } from '../src/index.ts'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('PWA session projections', () => {
  it('projects sealed application payloads without prompt or credential plaintext', () => {
    const secret = 'never-store-this-prompt-in-the-pwa-view'
    const followUp = projectRelaySessionView({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    })
    expect(followUp).toEqual({ kind: 'follow-up', sessionId: 'sess-1' })
    expect(JSON.stringify(followUp)).not.toContain(secret)

    expect(projectRelaySessionView({
      kind: 'session-event',
      sessionId: 'sess-1',
      type: 'tool.progress',
      detail: 'reading src/main.ts',
    })).toEqual({
      kind: 'progress',
      sessionId: 'sess-1',
      type: 'tool.progress',
      detail: 'reading src/main.ts',
    })
    expect(projectRelaySessionView({
      kind: 'approval',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })).toEqual({
      kind: 'approval',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })
    expect(projectRelaySessionView({
      kind: 'cancel',
      sessionId: 'sess-1',
      requestId: 'req-1',
    })).toEqual({
      kind: 'cancel',
      sessionId: 'sess-1',
      requestId: 'req-1',
    })
    expect(projectRelaySessionView({
      kind: 'presence',
      state: 'online',
    })).toEqual({ kind: 'presence', state: 'online' })
  })

  it('refuses model credential fields on a projection payload', () => {
    expectRelayError(
      () => projectRelaySessionView({
        kind: 'session-event',
        sessionId: 'sess-1',
        type: 'boot',
        detail: 'ok',
        DEEPSEEK_API_KEY: 'sk-secret',
      } as never),
      'plaintext',
    )
  })
})
