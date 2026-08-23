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
        // colorDiff は (Δr²+Δg²+Δb²)/(255²×3)。0.05 だと各チャンネル±57まで背景扱いになり、
        // 薄い文字やグローを飛び越えて前景まで削る（実測: 下辺だけ172px食い込んだ）。
        // 0.001（±8/ch）は生成画像の背景ノイズ（±4〜8/ch）のすぐ上で、前景境界と1〜2pxで一致する
        tolerance: 0.001,
        cropOnlyFrames: true,
        // false のとき leaveBorder は「各辺ちょうどこの余白を残す」になる。
        // true にすると削り量が対辺で揃うだけで、余白はかえって不均一になる
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
