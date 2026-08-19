import { describe, expect, it } from 'vitest'
import { RelayAuthorizationError } from '../../relay-protocol/src/index.ts'
import { assertPwaRelayRecord } from '../src/credentials.ts'

function expectRelayError(run: () => unknown, code: string): void {
  try {
    run()
    expect.unreachable('expected a relay authorization error')
  } catch (cause) {
    expect(cause).toBeInstanceOf(RelayAuthorizationError)
    expect((cause as RelayAuthorizationError).code).toBe(code)
  }
}

describe('PWA credential refusal', () => {
  it('refuses model credentials and device private keys', () => {
    expectRelayError(
      () => assertPwaRelayRecord({ DEEPSEEK_API_KEY: 'sk-secret' }, 'pwa record'),
      'plaintext',
    )
    expectRelayError(
      () => assertPwaRelayRecord({ privateKey: 'ed25519-secret' }, 'pwa record'),
      'plaintext',
    )
    expectRelayError(
      () => assertPwaRelayRecord({ encryptionPrivateKey: 'x25519-secret' }, 'pwa record'),
      'plaintext',
    )
  })
})
