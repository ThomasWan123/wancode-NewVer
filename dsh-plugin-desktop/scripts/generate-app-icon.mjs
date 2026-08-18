/** Rasterize the boxed-W SVG into the Windows/Linux application PNG. */

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import sharp from 'sharp'

const APP_ICON_SIZE = 1024
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const sourcePath = join(packageRoot, 'build', 'app-icon.svg')
const outputPath = join(packageRoot, 'build', 'app-icon.png')

/**
 * Render `app-icon.svg` as a 1024 RGBA16 PNG with an sRGB ICC profile.
 * @param {string} source - absolute path to the boxed-W SVG.
 * @param {string} output - absolute path for the generated PNG.
 * @returns {Promise<void>} Resolves after the complete PNG has been written.
 */
export async function generateAppIcon(source = sourcePath, output = outputPath) {
  const svg = await readFile(source)
  const rendered = await sharp(svg, { density: 384 })
    .resize({
      width: APP_ICON_SIZE,
      height: APP_ICON_SIZE,
      fit: 'fill',
      kernel: sharp.kernel.lanczos3,
    })
    .ensureAlpha()
    .toColourspace('rgb16')
    .withIccProfile('srgb')
    .png({
      compressionLevel: 9,
      progressive: false,
      adaptiveFiltering: false,
      palette: false,
    })
    .toBuffer()

  const metadata = await sharp(rendered).metadata()
  if (
    metadata.format !== 'png'
    || metadata.width !== APP_ICON_SIZE
    || metadata.height !== APP_ICON_SIZE
    || metadata.space !== 'rgb16'
    || metadata.depth !== 'ushort'
    || metadata.bitsPerSample !== 16
    || metadata.channels !== 4
    || metadata.hasAlpha !== true
    || metadata.icc === undefined
  ) {
    throw new Error(`generate-app-icon: expected a ${APP_ICON_SIZE}x${APP_ICON_SIZE} RGBA16 PNG with an ICC profile`)
  }

  await writeFile(output, rendered)
}

const invokedPath = process.argv[1]
if (invokedPath !== undefined && resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await generateAppIcon()
}
