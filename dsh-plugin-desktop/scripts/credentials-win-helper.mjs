/** Short-lived Windows Credential Manager helper. One stdin JSON request, one stdout JSON reply. Never logs secret values. */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(new URL('../package.json', import.meta.url))
const koffi = require('koffi')

const CREDENTIAL_TYPE_GENERIC = 1
const ERROR_NOT_FOUND = 1168
const MAX_CREDENTIAL_BLOB_BYTES = 5 * 512

const FILETIME = koffi.struct('WANCODE_HELPER_FILETIME', {
  dwLowDateTime: 'uint32',
  dwHighDateTime: 'uint32',
})

/**
 * Optional LPCWSTR fields use empty strings rather than JS null.
 * koffi's `str16` converter has been observed to AV when marshalling null.
 * CredentialBlob is an explicit uint8_t pointer filled through a koffi view
 * so CredWriteW does not depend on Node Buffer pointer marshalling.
 */
const CREDENTIALW = koffi.struct('WANCODE_HELPER_CREDENTIALW', {
  Flags: 'uint32',
  Type: 'uint32',
  TargetName: 'str16',
  Comment: 'str16',
  LastWritten: FILETIME,
  CredentialBlobSize: 'uint32',
  CredentialBlob: 'uint8_t *',
  Persist: 'uint32',
  AttributeCount: 'uint32',
  Attributes: 'void *',
  TargetAlias: 'str16',
  UserName: 'str16',
})

const advapi32 = koffi.load('advapi32.dll')
const kernel32 = koffi.load('kernel32.dll')
const credRead = advapi32.func(
  'int __stdcall CredReadW(str16 target, uint32 type, uint32 flags, _Out_ WANCODE_HELPER_CREDENTIALW **credential)',
)
const credWrite = advapi32.func(
  'int __stdcall CredWriteW(const WANCODE_HELPER_CREDENTIALW *credential, uint32 flags)',
)
const credDelete = advapi32.func(
  'int __stdcall CredDeleteW(str16 target, uint32 type, uint32 flags)',
)
const credFree = advapi32.func('void __stdcall CredFree(void *buffer)')
const getLastError = kernel32.func('uint32 __stdcall GetLastError()')

/**
 * Write one protocol reply to stdout.
 * @param {Record<string, unknown>} payload
 */
function reply(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

/**
 * @param {string} operation
 * @param {string} target
 * @param {number} win32
 * @returns {{ ok: false, error: string, win32: number }}
 */
function fail(operation, target, win32) {
  return {
    ok: false,
    error: `${operation} failed for ${target}`,
    win32,
  }
}

/**
 * Copy UTF-16LE bytes into koffi-owned memory.
 * @param {string} value
 * @returns {{ byteLength: number, blobPtr: unknown }}
 */
function copyBlob(value) {
  const blob = Buffer.from(value, 'utf16le')
  if (blob.byteLength > MAX_CREDENTIAL_BLOB_BYTES) {
    throw new Error('blob exceeds the Windows generic credential limit')
  }
  if (blob.byteLength === 0) {
    return { byteLength: 0, blobPtr: null }
  }
  const blobPtr = koffi.alloc('uint8_t', blob.byteLength)
  const view = koffi.view(blobPtr, blob.byteLength)
  new Uint8Array(view).set(blob)
  return { byteLength: blob.byteLength, blobPtr }
}

/**
 * @param {unknown} request
 * @returns {Record<string, unknown>}
 */
function handle(request) {
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return { ok: false, error: 'invalid request' }
  }
  const body = /** @type {Record<string, unknown>} */ (request)
  const op = body.op
  const target = body.target
  if (op !== 'get' && op !== 'set' && op !== 'delete') {
    return { ok: false, error: 'invalid op' }
  }
  if (typeof target !== 'string' || target.length === 0) {
    return { ok: false, error: 'invalid target' }
  }

  if (op === 'get') {
    process.stderr.write('credentials-win-helper: CredReadW begin\n')
    const out = [null]
    if (credRead(target, CREDENTIAL_TYPE_GENERIC, 0, out) === 0) {
      const win32 = getLastError()
      process.stderr.write(`credentials-win-helper: CredReadW win32=${String(win32)} ok=0\n`)
      if (win32 === ERROR_NOT_FOUND) return { ok: true, win32 }
      return fail('CredReadW', target, win32)
    }
    const pointer = out[0]
    try {
      const credential = koffi.decode(pointer, CREDENTIALW)
      const size = credential.CredentialBlobSize
      process.stderr.write(`credentials-win-helper: CredReadW decoded blobBytes=${String(size)} win32=0 ok=1\n`)
      if (size === 0) return { ok: true }
      const bytes = Buffer.from(
        koffi.decode(credential.CredentialBlob, koffi.array('uint8_t', size, 'Buffer')),
      )
      const value = bytes.toString('utf16le')
      return value.length === 0 ? { ok: true } : { ok: true, value }
    } finally {
      credFree(pointer)
    }
  }

  if (op === 'delete') {
    process.stderr.write('credentials-win-helper: CredDeleteW begin\n')
    if (credDelete(target, CREDENTIAL_TYPE_GENERIC, 0) !== 0) {
      process.stderr.write('credentials-win-helper: CredDeleteW win32=0 ok=1\n')
      return { ok: true, value: '1' }
    }
    const win32 = getLastError()
    const missing = win32 === ERROR_NOT_FOUND
    process.stderr.write(
      `credentials-win-helper: CredDeleteW win32=${String(win32)} ok=${missing ? '1' : '0'}\n`,
    )
    if (missing) return { ok: true, value: '0', win32 }
    return fail('CredDeleteW', target, win32)
  }

  const value = body.value
  const persist = body.persist
  if (typeof value !== 'string') {
    return { ok: false, error: 'invalid value' }
  }
  if (typeof persist !== 'number' || !Number.isInteger(persist)) {
    return { ok: false, error: 'invalid persist' }
  }

  let blobPtr
  try {
    const copied = copyBlob(value)
    blobPtr = copied.blobPtr
    process.stderr.write(
      `credentials-win-helper: CredWriteW persist=${String(persist)} blobBytes=${String(copied.byteLength)}\n`,
    )
    const ok = credWrite({
      Flags: 0,
      Type: CREDENTIAL_TYPE_GENERIC,
      TargetName: target,
      Comment: '',
      LastWritten: { dwLowDateTime: 0, dwHighDateTime: 0 },
      CredentialBlobSize: copied.byteLength,
      CredentialBlob: blobPtr,
      Persist: persist,
      AttributeCount: 0,
      Attributes: null,
      TargetAlias: '',
      UserName: 'WanCodeNewVer',
    }, 0) !== 0
    const win32 = ok ? 0 : getLastError()
    process.stderr.write(
      `credentials-win-helper: CredWriteW persist=${String(persist)} win32=${String(win32)} ok=${ok ? '1' : '0'}\n`,
    )
    if (!ok) return fail('CredWriteW', target, win32)
    return { ok: true, win32 }
  } finally {
    if (blobPtr !== undefined && blobPtr !== null) koffi.free(blobPtr)
  }
}

function main() {
  let request
  try {
    request = JSON.parse(readFileSync(0, 'utf8'))
  } catch {
    reply({ ok: false, error: 'invalid request' })
    return
  }
  try {
    reply(handle(request))
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    reply({ ok: false, error })
  }
}

main()
