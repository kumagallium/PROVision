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
