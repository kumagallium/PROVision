import {
  backgroundRemovalCacheKeyOf,
  backgroundRemovalModelOf,
  resolveBackgroundRemovalCommand,
} from './background.js'
import { describe, expect, it } from 'vitest'

describe('背景透明化ツール', () => {
  it('カスタムコマンドをキャッシュ鍵とモデル識別子へ反映する', () => {
    const input = { imagePath: '/tmp/input.png', imageDigest: 'source' }
    const first = backgroundRemovalCacheKeyOf({
      ...input,
      command: '/tool/a {image} {out}',
    })
    const second = backgroundRemovalCacheKeyOf({
      ...input,
      command: '/tool/b {image} {out}',
    })
    expect(first).not.toBe(second)
    expect(backgroundRemovalModelOf('/tool/a {image} {out}')).toMatch(/^custom-/)
    expect(backgroundRemovalModelOf('/usr/bin/rembg i -m isnet-general-use {image} {out}')).toBe(
      'isnet-general-use',
    )
  })

  it('既定のコマンドはモデルを名指しする。rembg の既定は版で変わるので決め打てない', () => {
    // 2.0.83 の既定は bria-rmbg（1.02GB・非商用）だった。名指ししないと
    // 来歴に「U²-Net」と書きながら別のモデルで走る
    const command = resolveBackgroundRemovalCommand({}, () => true, '/Users/x')
    expect(command).toBe('/Users/x/.local/bin/rembg i -m u2net {image} {out}')
    expect(backgroundRemovalModelOf('/usr/bin/rembg i {image} {out}')).toBe('rembg-default')
  })

  it('カスタムコマンドの必須プレースホルダーを検証する', () => {
    expect(() =>
      resolveBackgroundRemovalCommand({
        PROVISION_BACKGROUND_COMMAND: '/tool/remover {image}',
      }),
    ).toThrow('{image} と {out}')
  })
})
