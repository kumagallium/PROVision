import { Jimp, loadFont, measureText, measureTextHeight } from 'jimp'
import {
  SANS_16_BLACK,
  SANS_16_WHITE,
  SANS_32_BLACK,
  SANS_32_WHITE,
  SANS_64_BLACK,
  SANS_64_WHITE,
  SANS_128_BLACK,
  SANS_128_WHITE,
} from 'jimp/fonts'
import type { ImageToolArguments, ImageToolName } from '../ai/planner.js'
import { sha256 } from '../prov/sha256.js'
import type { GenerateResult } from './mflux.js'

const JIMP_MODEL = 'jimp-1.6.1'

export type StandardImageTool = Extract<
  ImageToolName,
  | 'image.trim'
  | 'image.crop-square'
  | 'image.rotate'
  | 'image.resize'
  | 'image.wordmark'
  | 'image.brightness'
  | 'image.contrast'
  | 'image.gamma'
  | 'image.scalebar'
>

/** 帯の高さは文字高に対する比。シンボルと文字が窮屈にならない値（試作で決めた） */
const WORDMARK_BAND_RATIO = 1.9

/** 文字は画像幅のこの割合までに収める。端まで詰まるとロゴに見えない */
const WORDMARK_MAX_WIDTH_RATIO = 0.8

/** 白と黒それぞれ、大きい順。収まる最大を選ぶ */
const WORDMARK_FONTS = {
  white: [SANS_128_WHITE, SANS_64_WHITE, SANS_32_WHITE, SANS_16_WHITE],
  black: [SANS_128_BLACK, SANS_64_BLACK, SANS_32_BLACK, SANS_16_BLACK],
} as const

/** 画像の四隅から背景色を決める。継ぎ足す帯を地の色に合わせるため */
function estimateBackground(image: Awaited<ReturnType<typeof Jimp.read>>): number {
  const { width, height } = image.bitmap
  const corners: Array<[number, number]> = [
    [0, 0],
    [width - 1, 0],
    [0, height - 1],
    [width - 1, height - 1],
  ]
  let r = 0
  let g = 0
  let b = 0
  for (const [x, y] of corners) {
    const pixel = image.getPixelColor(x, y)
    r += (pixel >>> 24) & 255
    g += (pixel >>> 16) & 255
    b += (pixel >>> 8) & 255
  }
  r = Math.round(r / corners.length)
  g = Math.round(g / corners.length)
  b = Math.round(b / corners.length)
  return (((r << 24) >>> 0) + (g << 16) + (b << 8) + 255) >>> 0
}

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
  const { width, height } = image.bitmap

  if (input.tool === 'image.wordmark') {
    const text = input.arguments.text?.trim()
    if (!text) throw new Error('image.wordmarkには描く文字列が必要です')
    // 拡散モデルに描かせると字形が崩れる。フォントで確定的に置く
    const background = estimateBackground(image)
    // 明るい地に白を置くと読めない。地の明るさで色を決める
    const luminance =
      0.299 * ((background >>> 24) & 255) +
      0.587 * ((background >>> 16) & 255) +
      0.114 * ((background >>> 8) & 255)
    const candidates = luminance < 140 ? WORDMARK_FONTS.white : WORDMARK_FONTS.black
    const limit = width * WORDMARK_MAX_WIDTH_RATIO
    let font = await loadFont(candidates[candidates.length - 1]!)
    let textWidth = measureText(font, text)
    for (const candidate of candidates) {
      const loaded = await loadFont(candidate)
      const measured = measureText(loaded, text)
      if (measured <= limit) {
        font = loaded
        textWidth = measured
        break
      }
    }
    if (textWidth > width) {
      throw new Error('文字が画像の幅に収まりません。短い文字列にするか画像を広げてください')
    }
    const textHeight = measureTextHeight(font, text, width)
    // padding は文字の上下に置く余白。指定が無ければ従来の比率で決める
    const band =
      input.arguments.padding !== undefined
        ? textHeight + input.arguments.padding * 2
        : Math.round(textHeight * WORDMARK_BAND_RATIO)
    const canvas = new Jimp({ width, height: height + band, color: background })
    canvas.blit({ src: image, x: 0, y: 0 })
    canvas.print({
      font,
      x: Math.round((width - textWidth) / 2),
      y: Math.round(height + (band - textHeight) / 2),
      text,
    })
    const wordmarkPng = await canvas.getBuffer('image/png')
    return {
      png: new Uint8Array(wordmarkPng),
      model: JIMP_MODEL,
      provider: 'library:jimp',
      startedAtTime,
      endedAtTime: new Date().toISOString(),
    }
  }

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
        // 逆に 0.001（±8/ch）は厳しすぎて、背景にグラデーションがあると端で止まる
        // （実測: 上辺が9pxしか進まず、leaveBorderに満たずに何も削らなかった）。
        // 0.005（±18/ch）は前景境界を最大4pxしか越えず、leaveBorder で吸収できる
        tolerance: 0.005,
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
  } else if (input.tool === 'image.brightness') {
    // Jimp の brightness は倍率で、1 が無変換。amount は「無変換からの変化率（％）」なので
    // 1 + amount/100 に直す。**画像全体に同じ規則をかける**（局所補正はしない。D-020）
    image.brightness(1 + (input.arguments.amount ?? 0) / 100)
  } else if (input.tool === 'image.contrast') {
    // Jimp の contrast は -1〜1 で 0 が無変換。amount はそのまま％
    image.contrast((input.arguments.amount ?? 0) / 100)
  } else if (input.tool === 'image.gamma') {
    /**
     * ガンマ補正。**非線形**なので、明るさ・コントラストとは別のツールにしてある。
     * amount は「無変換からの変化率（％）」で、0 が無変換（明るさ・コントラストと揃える）。
     * 画像全体に同じ写像をかける——局所補正はしない（D-020）
     */
    const gamma = Math.max(0.1, 1 + (input.arguments.amount ?? 0) / 100)
    const table = new Uint8Array(256)
    for (let value = 0; value < 256; value += 1) {
      table[value] = Math.round(255 * (value / 255) ** (1 / gamma))
    }
    const data = image.bitmap.data
    for (let offset = 0; offset < data.length; offset += 4) {
      // アルファは触らない。透明度を変えるのは明暗の調整ではない
      data[offset] = table[data[offset]!]!
      data[offset + 1] = table[data[offset + 1]!]!
      data[offset + 2] = table[data[offset + 2]!]!
    }
  } else if (input.tool === 'image.scalebar') {
    const label = input.arguments.text?.trim()
    const barWidth = input.arguments.width
    if (!label || barWidth === undefined) {
      throw new Error('image.scalebarには描く文字列と棒の長さ（px）が必要です')
    }
    /**
     * スケールバー。**物理的な尺度は PROVision には分からない**ので、
     * 棒の長さ（px）も文字列も利用者が言ったものをそのまま描く。両方とも来歴へ残るので、
     * 主張の責任は人間 Agent にある（D-006）。
     *
     * 元の画素は書き換えず、右下へ重ねるだけ（`pixelOrigin` は `annotated`）
     */
    const bar = Math.min(barWidth, Math.round(width * 0.9))
    const thickness = Math.max(3, Math.round(height * 0.008))
    const margin = Math.max(8, Math.round(Math.min(width, height) * 0.04))
    // 右下の地の明るさで色を決める。明るい地に白を置くと読めない
    const sample = image.getPixelColor(
      Math.max(0, width - margin - Math.round(bar / 2)),
      Math.max(0, height - margin - thickness),
    )
    const luminance =
      0.299 * ((sample >>> 24) & 255) +
      0.587 * ((sample >>> 16) & 255) +
      0.114 * ((sample >>> 8) & 255)
    const light = luminance < 140
    const ink = light ? 0xffffffff : 0x000000ff
    const font = await loadFont(light ? SANS_16_WHITE : SANS_16_BLACK)
    const textWidth = measureText(font, label)
    const textHeight = measureTextHeight(font, label, width)
    const barX = Math.max(0, width - margin - bar)
    const barY = Math.max(0, height - margin - thickness)
    for (let y = barY; y < Math.min(height, barY + thickness); y += 1) {
      for (let x = barX; x < Math.min(width, barX + bar); x += 1) {
        image.setPixelColor(ink, x, y)
      }
    }
    image.print({
      font,
      x: Math.max(0, barX + Math.round((bar - textWidth) / 2)),
      y: Math.max(0, barY - textHeight - Math.round(thickness / 2)),
      text: label,
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
