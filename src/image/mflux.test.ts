import { describe, expect, it } from 'vitest'
import { modelIdOf, resolveImageCommand } from './mflux.js'

const TEMPLATE =
  '/Users/x/.local/bin/mflux-generate-z-image-turbo ' +
  '--model /Users/x/.cache/geologo/z-image-turbo-4bit --base-model z-image-turbo ' +
  '--prompt-file {promptFile} --seed {seed} --output {out}'

describe('画像生成コマンドの解決', () => {
  it('環境変数が最優先', () => {
    expect(resolveImageCommand({ PROVISION_IMAGE_COMMAND: TEMPLATE })).toBe(TEMPLATE)
  })

  it('{out} が無いテンプレートは受け付けない', () => {
    expect(() =>
      resolveImageCommand({ PROVISION_IMAGE_COMMAND: 'foo --prompt {prompt}' }),
    ).toThrow(/\{out\}/)
  })

  it('モデル識別子を取り出せる（再現に要るので記録する）', () => {
    expect(modelIdOf(TEMPLATE)).toBe('z-image-turbo-4bit')
    expect(modelIdOf('/usr/local/bin/some-generator --output {out}')).toBe(
      'some-generator',
    )
  })
})
