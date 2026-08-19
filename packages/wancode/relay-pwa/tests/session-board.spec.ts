import { describe, expect, it } from 'vitest'
import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import { createPwaSessionBoard, projectRelaySessionView } from '../src/index.ts'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('PWA session board', () => {
  it('folds streaming progress into a snapshot without prompt text', () => {
    const secret = 'never-store-this-prompt-on-the-session-board'
    const board = createPwaSessionBoard()
    expect(board.apply(projectRelaySessionView({
      kind: 'prompt',
      sessionId: 'sess-1',
      text: secret,
    }))).toEqual({
      sessionId: 'sess-1',
      status: 'running',
    })
    expect(board.apply({
      kind: 'progress',
      sessionId: 'sess-1',
      type: 'assistant.delta',
      detail: 'Looking at the form',
    })).toEqual({
      sessionId: 'sess-1',
      status: 'running',
      lastType: 'assistant.delta',
      lastDetail: 'Looking at the form',
    })
    expect(board.apply({
      kind: 'progress',
      sessionId: 'sess-1',
      type: 'notify.tool',
      detail: 'Waiting for approval',
    })).toEqual({
      sessionId: 'sess-1',
      status: 'awaiting-approval',
      lastType: 'notify.tool',
      lastDetail: 'Waiting for approval',
      notification: {
        kind: 'notification',
        sessionId: 'sess-1',
        type: 'notify.tool',
        detail: 'Waiting for approval',
      },
    })
    expect(JSON.stringify(board.list())).not.toContain(secret)
    expect(board.apply({ kind: 'presence', state: 'online' })).toBeUndefined()
  })

  it('records approval and cancel without growing an event log', () => {
    const board = createPwaSessionBoard()
    board.apply({ kind: 'follow-up', sessionId: 'sess-1' })
    expect(board.apply({
      kind: 'approval',
      sessionId: 'sess-1',
      requestId: 'req-1',
      approved: true,
    })).toEqual({
      sessionId: 'sess-1',
      status: 'running',
    })
    expect(board.apply({
      kind: 'cancel',
      sessionId: 'sess-1',
      requestId: 'req-1',
    })).toEqual({
      sessionId: 'sess-1',
      status: 'cancelled',
      pendingRequestId: 'req-1',
    })
    expect(board.list()).toHaveLength(1)
    expect(board.apply({
      kind: 'follow-up',
      sessionId: 'sess-1',
    })).toEqual({
      sessionId: 'sess-1',
      status: 'running',
    })
    expect(board.apply({
      kind: 'progress',
      sessionId: 'sess-1',
      type: 'assistant.done',
      detail: 'Finished',
    })).toEqual({
      sessionId: 'sess-1',
      status: 'complete',
      lastType: 'assistant.done',
      lastDetail: 'Finished',
    })
  })

  it('refuses model credential fields on a session view', () => {
    const board = createPwaSessionBoard()
    expectRelayError(
      () => board.apply({
        kind: 'follow-up',
        sessionId: 'sess-1',
        DEEPSEEK_API_KEY: 'sk-secret',
      } as never),
      'plaintext',
    )
  })
})
