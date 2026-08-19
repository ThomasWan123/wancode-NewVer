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

/**
 * Refuse plaintext application fields and model API keys on untrusted PWA JSON.
 * Device private keys are not checked here; they must never be copied onto
 * this record by the caller.
 */
export function assertPwaRelayRecord(record: Record<string, unknown>, label: string): void {
  assertNoPlaintextRelayFields(record, label)
  for (const field of MODEL_CREDENTIAL_FIELDS) {
    if (field in record) {
      throw new RelayAuthorizationError('plaintext', `${label} must not carry ${field}`)
    }
  }
}
