import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { afterEach, describe, expect, it } from 'vitest'
import { sha256 } from '../prov/sha256.js'
import { processStandardImage } from './standard.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function sourceImage(): Promise<{ path: string; digest: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'provision-standard-test-'))
  dirs.push(dir)
  const path = join(dir, 'source.png')
  const png = await new Jimp({ width: 100, height: 60, color: 0x334455ff }).getBuffer('image/png')
  await writeFile(path, png)
  return { path, digest: sha256(new Uint8Array(await readFile(path))) }
}

describe('画像全体の明暗（D-020 の photometric）', () => {
  /** 出力 PNG の左上の R 値。全体に同じ規則をかけているかを見る */
  async function firstRed(png: Uint8Array): Promise<number> {
    const image = await Jimp.read(Buffer.from(png))
    return (image.getPixelColor(0, 0) >>> 24) & 255
  }

  it('明るさは amount=0 で無変換、正で明るく、負で暗くなる', async () => {
    const source = await sourceImage()
    const base = 0x33 // sourceImage の R
    const at = async (amount: number) =>
      firstRed(
        (
          await processStandardImage({
            tool: 'image.brightness',
            arguments: { amount },
            imagePath: source.path,
            imageDigest: source.digest,
          })
        ).png,
      )
    expect(await at(0)).toBe(base)
    expect(await at(100)).toBeGreaterThan(base)
    expect(await at(-50)).toBeLessThan(base)
  })

  it('コントラストは amount=0 で無変換', async () => {
    const source = await sourceImage()
    const result = await processStandardImage({
      tool: 'image.contrast',
      arguments: { amount: 0 },
      imagePath: source.path,
      imageDigest: source.digest,
    })
    expect(await firstRed(result.png)).toBe(0x33)
  })

  it('全体に同じ規則をかける。局所的に差をつけない', async () => {
    // 半分だけ明るい画像を作り、差が保たれる（＝一様な写像である）ことを見る
    const dir = await mkdtemp(join(tmpdir(), 'provision-photometric-test-'))
    dirs.push(dir)
    const path = join(dir, 'halves.png')
    const image = new Jimp({ width: 20, height: 4, color: 0x404040ff })
    for (let y = 0; y < 4; y++) {
      for (let x = 10; x < 20; x++) image.setPixelColor(0x808080ff, x, y)
    }
    await writeFile(path, await image.getBuffer('image/png'))
    const digest = sha256(new Uint8Array(await readFile(path)))
    const result = await processStandardImage({
      tool: 'image.brightness',
      arguments: { amount: 50 },
      imagePath: path,
      imageDigest: digest,
    })
    const out = await Jimp.read(Buffer.from(result.png))
    const left = (out.getPixelColor(0, 0) >>> 24) & 255
    const right = (out.getPixelColor(15, 0) >>> 24) & 255
    // 0x40 と 0x80 に同じ倍率 1.5 がかかる
    expect(left).toBe(0x60)
    expect(right).toBe(0xc0)
  })
})

describe('標準画像処理', () => {
  it('背景にむらがあっても余白を削る', async () => {
    // 生成画像の背景はグラデーションとノイズを持つ。判定が厳しすぎると端で止まり、
    // leaveBorder に満たず何も削らない（実測: 上辺が9pxしか進まなかった）
    const dir = await mkdtemp(join(tmpdir(), 'provision-trim-test-'))
    dirs.push(dir)
    const path = join(dir, 'gradient.png')
    const image = new Jimp({ width: 120, height: 120, color: 0x0a1030ff })
    // 上ほど明るくなる背景を作る
    for (let y = 0; y < 120; y++) {
      const shade = 0x0a + Math.round((119 - y) / 12)
      for (let x = 0; x < 120; x++) {
        image.setPixelColor(((shade << 24) >>> 0) + (0x10 << 16) + (0x30 << 8) + 255, x, y)
      }
    }
    // 中央へ前景を置く
    for (let y = 45; y < 75; y++) {
      for (let x = 45; x < 75; x++) image.setPixelColor(0xffffffff, x, y)
    }
    await writeFile(path, await image.getBuffer('image/png'))
    const digest = sha256(new Uint8Array(await readFile(path)))

    const result = await processStandardImage({
      tool: 'image.trim',
      arguments: { padding: 5 },
      imagePath: path,
      imageDigest: digest,
    })
    const out = await Jimp.fromBuffer(Buffer.from(result.png))
    expect(out.bitmap.width).toBeLessThan(120)
    expect(out.bitmap.height).toBeLessThan(120)
    // 前景（30px）と余白（左右5pxずつ）は残る
    expect(out.bitmap.width).toBeGreaterThanOrEqual(40)
  })

  it('ワードマークは帯を継ぎ足して幅を保つ', async () => {
    const source = await sourceImage()
    const result = await processStandardImage({
      tool: 'image.wordmark',
      arguments: { text: 'asterism' },
      imagePath: source.path,
      imageDigest: source.digest,
    })
    const out = await Jimp.fromBuffer(Buffer.from(result.png))
    expect(out.bitmap.width).toBe(100)
    expect(out.bitmap.height).toBeGreaterThan(60)
    expect(result.model).toBe('jimp-1.6.1')
  })

  it('余白を指定すると帯の高さが変わり、文字は消えない', async () => {
    const source = await sourceImage()
    const make = (padding?: number) =>
      processStandardImage({
        tool: 'image.wordmark',
        arguments: { text: 'asterism', ...(padding !== undefined ? { padding } : {}) },
        imagePath: source.path,
        imageDigest: source.digest,
      })
    const narrow = await Jimp.fromBuffer(Buffer.from((await make(4)).png))
    const wide = await Jimp.fromBuffer(Buffer.from((await make(40)).png))
    expect(wide.bitmap.height).toBeGreaterThan(narrow.bitmap.height)
    // 元の絵の幅は変えない。継ぎ足すのは下だけ
    expect(narrow.bitmap.width).toBe(100)
    expect(wide.bitmap.width).toBe(100)
  })

  it('同じ文字列なら同じ絵になる（決定的）', async () => {
    const source = await sourceImage()
    const input = {
      tool: 'image.wordmark' as const,
      arguments: { text: 'asterism' },
      imagePath: source.path,
      imageDigest: source.digest,
    }
    const a = await processStandardImage(input)
    const b = await processStandardImage(input)
    expect(sha256(a.png)).toBe(sha256(b.png))
  })

  it('文字列がないワードマークを拒否する', async () => {
    const source = await sourceImage()
    await expect(
      processStandardImage({
        tool: 'image.wordmark',
        arguments: {},
        imagePath: source.path,
        imageDigest: source.digest,
      }),
    ).rejects.toThrow('文字列')
  })

  it('中央を正方形に切り抜く', async () => {
    const source = await sourceImage()
    const result = await processStandardImage({
      tool: 'image.crop-square',
      arguments: {},
      imagePath: source.path,
      imageDigest: source.digest,
    })
    const output = await Jimp.read(Buffer.from(result.png))
    expect(output.bitmap).toMatchObject({ width: 60, height: 60 })
    expect(result.provider).toBe('library:jimp')
  })

  it('指定寸法へリサイズする', async () => {
    const source = await sourceImage()
    const result = await processStandardImage({
      tool: 'image.resize',
      arguments: { width: 40, height: 20 },
      imagePath: source.path,
      imageDigest: source.digest,
    })
    const output = await Jimp.read(Buffer.from(result.png))
    expect(output.bitmap).toMatchObject({ width: 40, height: 20 })
  })

  it('余白を切って各辺に指定の余白を残す — 薄い模様も前景として飛び越えない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provision-standard-test-'))
    dirs.push(dir)
    const path = join(dir, 'logo.png')
    // 暗い背景の中央に明るい図形、下辺近くに薄い文字状の帯を置く。
    // 帯（Δ約30/ch）を背景と誤認すると、下だけ図形まで食い込む（実際に起きた事故の再現）
    const image = new Jimp({ width: 200, height: 200, color: 0x060718ff })
    for (let y = 60; y < 120; y++)
      for (let x = 50; x < 150; x++) image.setPixelColor(0xf0f0f0ff, x, y)
    for (let y = 150; y < 160; y++)
      for (let x = 70; x < 130; x++) image.setPixelColor(0x252637ff, x, y)
    await writeFile(path, await image.getBuffer('image/png'))
    const digest = sha256(new Uint8Array(await readFile(path)))

    const result = await processStandardImage({
      tool: 'image.trim',
      arguments: { padding: 10 },
      imagePath: path,
      imageDigest: digest,
    })
    const output = await Jimp.read(Buffer.from(result.png))
    // 前景は x:50-149, y:60-159（薄い帯まで含む）。各辺に10px残す
    expect(output.bitmap).toMatchObject({ width: 120, height: 120 })
    // 薄い帯が右下側に残っている＝飛び越えていない
    const band = output.getPixelColor(60, 105)
    expect(band).toBe(0x252637ff)
  })

  it('全面が同じ色の画像を余白と誤認して縮めない', async () => {
    const source = await sourceImage()
    const result = await processStandardImage({
      tool: 'image.trim',
      arguments: { padding: 24 },
      imagePath: source.path,
      imageDigest: source.digest,
    })
    const output = await Jimp.read(Buffer.from(result.png))
    expect(output.bitmap).toMatchObject({ width: 100, height: 60 })
  })
})
