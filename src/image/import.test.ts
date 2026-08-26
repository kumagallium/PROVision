import { describe, expect, it } from 'vitest'
import { Jimp } from 'jimp'
import { baseFileName, detectMediaType, importImage } from './import.js'
import { sha256 } from '../prov/sha256.js'

async function made(mime: 'image/png' | 'image/jpeg'): Promise<Uint8Array> {
  const image = new Jimp({ width: 8, height: 8, color: 0x336699ff })
  return new Uint8Array(await image.getBuffer(mime))
}

describe('外から持ち込んだ画像の取り込み（D-019）', () => {
  it('PNG はそのまま通す。触ると内容ハッシュが変わる', async () => {
    const bytes = await made('image/png')
    const result = await importImage(bytes)
    // 再エンコードすると走査線フィルタが変わり、画素が同じでも digest が変わる（D-010）
    expect(result.png).toEqual(bytes)
    expect(result.converted).toBe(false)
    expect(result.sourceFileMediaType).toBe('image/png')
  })

  it('PNG 以外は PNG へ直し、直したことを残す', async () => {
    const result = await importImage(await made('image/jpeg'))
    expect(result.sourceFileMediaType).toBe('image/jpeg')
    expect(result.converted).toBe(true)
    expect(detectMediaType(result.png)).toBe('image/png')
  })

  it('元ファイルのハッシュは、変換後ではなく渡されたバイト列そのもの', async () => {
    // 手元の生ファイルと図版の出発点を結びつけるための値なので、変換後では意味がない
    const bytes = await made('image/jpeg')
    const result = await importImage(bytes)
    expect(result.sourceFileDigest).toBe(sha256(bytes))
  })

  it('形式は名乗りではなく中身で決める', () => {
    expect(detectMediaType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(detectMediaType(new Uint8Array([0x49, 0x49, 0x2a, 0x00]))).toBe('image/tiff')
    expect(detectMediaType(new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]))).toBe('image/tiff')
    // 分からないものは推測しない
    expect(detectMediaType(new Uint8Array([1, 2, 3, 4]))).toBeUndefined()
  })

  it('読めない形式と空のファイルは拒む', async () => {
    await expect(importImage(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(/PNG/)
    await expect(importImage(new Uint8Array())).rejects.toThrow(/空/)
  })

  it('ファイル名はパスを落とす。利用者名を書き出したファイルへ載せない', () => {
    expect(baseFileName('/Users/someone/Desktop/figure 2-final.png')).toBe('figure 2-final.png')
    // 空白やハイフンは名前の一部なので残す
    expect(baseFileName('a b-c.png')).toBe('a b-c.png')
  })
})
