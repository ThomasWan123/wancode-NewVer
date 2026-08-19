/** Recover the next Electron generation after an unclean Windows exit. */

import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

const BIN_NAME = 'dsh-plugin-desktop'

/** Marker written only after an orderly native quit. */
export const DESKTOP_CLEAN_EXIT_MARKER = 'clean-exit'

/** Chromium GPU cache that can poison the next boot after a native crash. */
export const DESKTOP_GPU_CACHE_DIRECTORY = 'GPUCache'

/** Outcome of inspecting the previous generation's exit marker. */
export interface DesktopCrashRecovery {
  /** Call `app.disableHardwareAcceleration()` before `whenReady` when true. */
  readonly disableHardwareAcceleration: boolean
  /** True when the previous run left GPU cache without a clean-exit marker. */
  readonly recoveredFromCrash: boolean
}

/**
 * Inspect user data for an unclean previous exit and clear poisoned GPU cache.
 * Must run before `app.whenReady()`.
 * @param userDataPath - absolute Electron user-data directory.
 * @returns whether this generation should start without GPU acceleration.
 */
export function prepareDesktopCrashRecovery(userDataPath: string): DesktopCrashRecovery {
  const root = validatedUserDataPath(userDataPath)
  const markerPath = join(root, DESKTOP_CLEAN_EXIT_MARKER)
  const gpuCachePath = join(root, DESKTOP_GPU_CACHE_DIRECTORY)
  const hadGpuCache = existsSync(gpuCachePath)
  const cleanExit = existsSync(markerPath)
  if (cleanExit) {
    try {
      unlinkSync(markerPath)
    } catch {
      // A stuck marker must not block startup; the next quit can rewrite it.
    }
  }
  const recoveredFromCrash = hadGpuCache && !cleanExit
  if (recoveredFromCrash) {
    try {
      rmSync(gpuCachePath, { recursive: true, force: true })
    } catch {
      // Boot continues even when the poisoned cache cannot be removed.
    }
  }
  return {
    disableHardwareAcceleration: recoveredFromCrash,
    recoveredFromCrash,
  }
}

/**
 * Record that this generation reached an orderly native quit.
 * @param userDataPath - absolute Electron user-data directory.
 */
export function markDesktopCleanExit(userDataPath: string): void {
  const root = validatedUserDataPath(userDataPath)
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, DESKTOP_CLEAN_EXIT_MARKER), '1\n')
}

function validatedUserDataPath(userDataPath: string): string {
  if (userDataPath.length === 0 || /[\0\r\n]/u.test(userDataPath) || !isAbsolute(userDataPath)) {
    throw new Error(`${BIN_NAME}: crash recovery requires an absolute user-data path`)
  }
  return resolve(userDataPath)
}
