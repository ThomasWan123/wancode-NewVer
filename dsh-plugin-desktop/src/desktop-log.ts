/** Local diagnostics log for packaged WanCodeNewVer processes that have no console. */

import {
  appendFileSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'
const LOG_FILE_NAME = 'wancode.log'
const ROTATED_LOG_FILE_NAME = 'wancode.previous.log'
const DEFAULT_MAX_LOG_BYTES = 5 * 1024 * 1024

/** Streams that can be mirrored into the diagnostics file. */
export interface DesktopLogStreams {
  readonly stdout: NodeJS.WriteStream
  readonly stderr: NodeJS.WriteStream
}

/** Return the diagnostics directory under Electron user data. */
export function desktopLogsDirectory(userDataPath: string): string {
  return join(validatedUserDataPath(userDataPath), 'logs')
}

/** Return the active diagnostics log path under Electron user data. */
export function desktopLogFilePath(userDataPath: string): string {
  return join(desktopLogsDirectory(userDataPath), LOG_FILE_NAME)
}

/**
 * Create the diagnostics directory if it does not already exist.
 * @param userDataPath - absolute Electron user-data directory.
 * @returns the created or existing logs directory.
 */
export function ensureDesktopLogsDirectory(userDataPath: string): string {
  const directory = desktopLogsDirectory(userDataPath)
  mkdirSync(directory, { recursive: true })
  return directory
}

/**
 * Append one diagnostics record, rotating the previous file when the cap would be exceeded.
 * Logging failures stay inside this function so callers can keep writing to stderr.
 * @param userDataPath - absolute Electron user-data directory.
 * @param text - already formatted log text, including a trailing newline when needed.
 * @param maxBytes - rotation threshold; defaults to 5 MiB.
 */
export function appendDesktopLog(
  userDataPath: string,
  text: string,
  maxBytes: number = DEFAULT_MAX_LOG_BYTES,
): void {
  if (text.length === 0) return
  try {
    const logPath = desktopLogFilePath(userDataPath)
    ensureDesktopLogsDirectory(userDataPath)
    rotateIfNeeded(logPath, Buffer.byteLength(text), maxBytes)
    appendFileSync(logPath, text)
  } catch {
    // A diagnostics file must never change Host or renderer outcomes.
  }
}

/**
 * Mirror process stdio into the diagnostics file for packaged GUI launches.
 * @param userDataPath - absolute Electron user-data directory.
 * @param streams - writable stdio streams, normally `process.stdout` and `process.stderr`.
 * @returns a disposer that restores the previous write functions.
 */
export function installDesktopLogMirror(
  userDataPath: string,
  streams: DesktopLogStreams = { stdout: process.stdout, stderr: process.stderr },
): () => void {
  validatedUserDataPath(userDataPath)
  const originalStdout = streams.stdout.write.bind(streams.stdout)
  const originalStderr = streams.stderr.write.bind(streams.stderr)
  let mirroring = false

  const wrap = (
    original: typeof streams.stdout.write,
  ): typeof streams.stdout.write => (
    function write(
      this: unknown,
      chunk: unknown,
      encoding?: unknown,
      callback?: unknown,
    ): boolean {
      const result = original(chunk as never, encoding as never, callback as never)
      if (!mirroring) {
        mirroring = true
        try {
          appendDesktopLog(userDataPath, toText(chunk))
        } finally {
          mirroring = false
        }
      }
      return result
    } as typeof streams.stdout.write
  )

  const wrappedStdout = wrap(originalStdout)
  const wrappedStderr = wrap(originalStderr)
  streams.stdout.write = wrappedStdout
  streams.stderr.write = wrappedStderr
  return () => {
    if (streams.stdout.write === wrappedStdout) streams.stdout.write = originalStdout
    if (streams.stderr.write === wrappedStderr) streams.stderr.write = originalStderr
  }
}

function rotateIfNeeded(logPath: string, incomingBytes: number, maxBytes: number): void {
  let size = 0
  try {
    size = statSync(logPath).size
  } catch (cause) {
    if (isNotFound(cause)) return
    throw cause
  }
  if (size + incomingBytes <= maxBytes) return
  const rotatedPath = join(resolve(logPath, '..'), ROTATED_LOG_FILE_NAME)
  try {
    rmSync(rotatedPath, { force: true })
  } catch {
    // A stuck previous log must not block rotation of the active file.
  }
  try {
    renameSync(logPath, rotatedPath)
  } catch {
    try {
      rmSync(logPath, { force: true })
    } catch {
      // Continue appending even when the oversized file cannot be moved.
    }
  }
}

function toText(chunk: unknown): string {
  if (typeof chunk === 'string') return chunk
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString('utf8')
  return String(chunk)
}

function validatedUserDataPath(userDataPath: string): string {
  if (userDataPath.length === 0 || /[\0\r\n]/u.test(userDataPath) || !isAbsolute(userDataPath)) {
    throw new Error(`${BIN_NAME}: diagnostics require an absolute user-data path`)
  }
  return resolve(userDataPath)
}

function isNotFound(cause: unknown): boolean {
  return typeof cause === 'object'
    && cause !== null
    && 'code' in cause
    && (cause as { code: unknown }).code === 'ENOENT'
}
