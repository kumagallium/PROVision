import { describe, expect, it } from 'vitest'
import { inpaintCacheKeyOf, resolveInpaintCommand } from './lama.js'

const TEMPLATE = 'lama --image {image} --mask {mask} --output {out}'

describe('LaMa inpainting', () => {
  it('環境変数でコマンドを指定できる', () => {
    expect(resolveInpaintCommand({ PROVISION_INPAINT_COMMAND: TEMPLATE })).toBe(TEMPLATE)
  })

  it('画像・マスク・出力の指定を必須にする', () => {
    expect(() =>
      resolveInpaintCommand({
        PROVISION_INPAINT_COMMAND: 'lama --image {image} --output {out}',
      }),
    ).toThrow('{mask}')
    expect(() =>
      resolveInpaintCommand({
        PROVISION_INPAINT_COMMAND: 'lama --image {image} --mask {mask}',
      }),
    ).toThrow('{out}')
  })

  it('画像かマスクが変わるとキャッシュキーも変わる', () => {
    const input = {
      imagePath: '/image.png',
      imageDigest: 'image-a',
      maskPath: '/mask.png',
      maskDigest: 'mask-a',
    }
    expect(inpaintCacheKeyOf(input)).not.toBe(
      inpaintCacheKeyOf({ ...input, maskDigest: 'mask-b' }),
    )
    expect(inpaintCacheKeyOf(input)).not.toBe(
      inpaintCacheKeyOf({ ...input, imageDigest: 'image-b' }),
    )
  })
})
