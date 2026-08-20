/** Deterministic PNG icons for the installable PWA shell. No extra renderer. */

import { deflateSync } from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const ICON_SIZES = [192, 512] as const
const BACKGROUND = [0x4d, 0x6b, 0xfe, 0xff] as const
const FOREGROUND = [0xff, 0xff, 0xff, 0xff] as const
/** Boxed-W path from the desktop app icon, in a 1024 viewBox. */
const W_PATH: ReadonlyArray<readonly [number, number]> = [
  [248, 292], [360, 292], [452, 584], [512, 396], [572, 584], [664, 292],
  [776, 292], [748, 732], [620, 732], [512, 422], [404, 732], [276, 732],
]

export type PwaShellIconSize = typeof ICON_SIZES[number]

/** Public icon files the installable shell caches. */
export const PWA_SHELL_ICON_FILES = {
  'icons/wancode-192.png': 192,
  'icons/wancode-512.png': 512,
} as const

/**
 * Build one opaque PNG icon. The W mark stays in the maskable safe zone.
 * Output never contains credentials or private keys.
 */
export function createPwaShellIcon(size: PwaShellIconSize): Buffer {
  if (size !== 192 && size !== 512) {
    throw new TypeError('pwa shell icon size must be 192 or 512')
  }
  const rowBytes = 1 + size * 4
  const raw = Buffer.alloc(rowBytes * size)
  const scale = size / 1024
  for (let y = 0; y < size; y++) {
    const row = y * rowBytes
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const color = pointInPolygon(x / scale, y / scale, W_PATH) ? FOREGROUND : BACKGROUND
      const pixel = row + 1 + x * 4
      raw[pixel] = color[0]
      raw[pixel + 1] = color[1]
      raw[pixel + 2] = color[2]
      raw[pixel + 3] = color[3]
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/** Return both installable PNG icons keyed by their public paths. */
export function createPwaShellIcons(): {
  readonly 'icons/wancode-192.png': Buffer
  readonly 'icons/wancode-512.png': Buffer
} {
  return {
    'icons/wancode-192.png': createPwaShellIcon(192),
    'icons/wancode-512.png': createPwaShellIcon(512),
  }
}

function pointInPolygon(
  x: number,
  y: number,
  polygon: ReadonlyArray<readonly [number, number]>,
): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]?.[0]
    const yi = polygon[i]?.[1]
    const xj = polygon[j]?.[0]
    const yj = polygon[j]?.[1]
    if (xi === undefined || yi === undefined || xj === undefined || yj === undefined) continue
    const intersect = (yi > y) !== (yj > y)
      && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi
    if (intersect) inside = !inside
  }
  return inside
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.byteLength)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
  return Buffer.concat([length, typeBytes, data, crc])
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
