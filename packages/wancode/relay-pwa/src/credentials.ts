/** Fail-closed refusal of model credentials on PWA inputs. */

import {
  RelayAuthorizationError,
  assertNoPlaintextRelayFields,
} from '../../relay-protocol/src/index.ts'

const MODEL_CREDENTIAL_FIELDS = [
  'apiKey',
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'modelKey',
] as const

const PRIVATE_KEY_FIELDS = ['privateKey', 'encryptionPrivateKey'] as const

/**
 * Refuse plaintext application fields, model API keys, and device private keys
 * on untrusted PWA JSON.
 */
export function assertPwaRelayRecord(record: Record<string, unknown>, label: string): void {
  assertNoPlaintextRelayFields(record, label)
  for (const field of MODEL_CREDENTIAL_FIELDS) {
    if (field in record) {
      throw new RelayAuthorizationError('plaintext', `${label} must not carry ${field}`)
    }
  }
  for (const field of PRIVATE_KEY_FIELDS) {
    if (field in record) {
      throw new RelayAuthorizationError('plaintext', `${label} must not carry ${field}`)
    }
  }
}
