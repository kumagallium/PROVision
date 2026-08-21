import { Jimp } from 'jimp'
import type { ImageToolArguments, ImageToolName } from '../ai/planner.js'
import { sha256 } from '../prov/sha256.js'
import type { GenerateResult } from './mflux.js'

const JIMP_MODEL = 'jimp-1.6.1'

export type StandardImageTool = Extract<
  ImageToolName,
  'image.trim' | 'image.crop-square' | 'image.rotate' | 'image.resize'
>

export interface StandardImageInput {
  tool: StandardImageTool
  arguments: ImageToolArguments
  imagePath: string
  imageDigest: string
}

export function standardImageCacheKeyOf(input: StandardImageInput): string {
  return sha256(
    [input.tool, JSON.stringify(input.arguments), input.imageDigest, JIMP_MODEL].join('\u0000'),
  ).slice(0, 32)
}

export async function processStandardImage(input: StandardImageInput): Promise<GenerateResult> {
  const startedAtTime = new Date().toISOString()
  const image = await Jimp.read(input.imagePath)

  if (input.tool === 'image.trim') {
    const first = image.bitmap.data.readUInt32BE(0)
    let hasVariation = false
    for (let offset = 4; offset < image.bitmap.data.length; offset += 4) {
      if (image.bitmap.data.readUInt32BE(offset) !== first) {
        hasVariation = true
        break
      }
    }
    if (hasVariation) {
      image.autocrop({
        tolerance: 0.05,
        cropOnlyFrames: true,
        cropSymmetric: false,
        leaveBorder: input.arguments.padding ?? 24,
      })
    }
  } else if (input.tool === 'image.crop-square') {
    const size = Math.min(image.bitmap.width, image.bitmap.height)
    image.crop({
      x: Math.floor((image.bitmap.width - size) / 2),
      y: Math.floor((image.bitmap.height - size) / 2),
      w: size,
      h: size,
    })
  } else if (input.tool === 'image.rotate') {
    image.rotate(input.arguments.angle!)
  } else if (input.tool === 'image.resize') {
    if (input.arguments.width !== undefined) {
      image.resize({
        w: input.arguments.width,
        ...(input.arguments.height !== undefined ? { h: input.arguments.height } : {}),
      })
    } else {
      image.resize({ h: input.arguments.height! })
    }
  }

  const png = await image.getBuffer('image/png')
  return {
    png: new Uint8Array(png),
    model: JIMP_MODEL,
    provider: 'library:jimp',
    startedAtTime,
    endedAtTime: new Date().toISOString(),
  }
}
