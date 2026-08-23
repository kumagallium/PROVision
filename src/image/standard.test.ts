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

describe('標準画像処理', () => {
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
