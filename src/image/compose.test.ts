import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { afterEach, describe, expect, it } from 'vitest'
import { composeCacheKeyOf, composeSources } from './compose.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function source(name: string, width: number, height: number, color: number) {
  const dir = await mkdtemp(join(tmpdir(), 'provision-compose-test-'))
  dirs.push(dir)
  const path = join(dir, `${name}.png`)
  await writeFile(path, await new Jimp({ width, height, color }).getBuffer('image/png'))
  return path
}

describe('融合の入力を 1 枚に畳む（D-021）', () => {
  it('高さを揃えて横に並べる', async () => {
    const a = await source('a', 40, 20, 0xff0000ff)
    const b = await source('b', 30, 40, 0x0000ffff)
    const png = await composeSources({ paths: [a, b], digests: ['a', 'b'] })
    const out = await Jimp.read(Buffer.from(png))
    // 高い方（40）に揃うので、a は 80x40 へ拡大される。幅は 80 + 30
    expect(out.bitmap.height).toBe(40)
    expect(out.bitmap.width).toBe(110)
    // 左が a（赤）、右が b（青）。順序は「利用者が居た版が先頭」という約束そのもの
    const red = (color: number) => (color >>> 24) & 255
    const blue = (color: number) => (color >>> 8) & 255
    expect(red(out.getPixelColor(5, 20))).toBe(255)
    expect(blue(out.getPixelColor(5, 20))).toBe(0)
    expect(red(out.getPixelColor(100, 20))).toBe(0)
    expect(blue(out.getPixelColor(100, 20))).toBe(255)
  })

  it('同じ材料からは同じ 1 枚が出る。確定的なので鍵は材料だけで足りる', async () => {
    const a = await source('a', 20, 20, 0x112233ff)
    const b = await source('b', 20, 20, 0x445566ff)
    const first = await composeSources({ paths: [a, b], digests: ['a', 'b'] })
    const second = await composeSources({ paths: [a, b], digests: ['a', 'b'] })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    expect(composeCacheKeyOf({ paths: [a, b], digests: ['a', 'b'] })).toBe(
      composeCacheKeyOf({ paths: [], digests: ['a', 'b'] }),
    )
    // 並び順が変われば別の 1 枚
    expect(composeCacheKeyOf({ paths: [], digests: ['b', 'a'] })).not.toBe(
      composeCacheKeyOf({ paths: [], digests: ['a', 'b'] }),
    )
  })

  it('1 枚では融合にならない', async () => {
    const a = await source('a', 10, 10, 0xffffffff)
    await expect(composeSources({ paths: [a], digests: ['a'] })).rejects.toThrow(/2 枚以上/)
  })
})
