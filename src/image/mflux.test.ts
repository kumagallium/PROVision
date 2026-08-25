import { describe, expect, it } from 'vitest'
import { modelIdOf, resolveImageCommand, resolveImageEditCommand } from './mflux.js'

const TEMPLATE =
  '/Users/x/.local/bin/mflux-generate-z-image-turbo ' +
  '--model /Users/x/.cache/geologo/z-image-turbo-4bit --base-model z-image-turbo ' +
  '--prompt-file {promptFile} --seed {seed} --output {out}'

describe('画像生成コマンドの解決', () => {
  it('編集用コマンドを生成用と分けて解決する', () => {
    const env = {
      PROVISION_IMAGE_COMMAND: 'gen --model base --output {out}',
      PROVISION_IMAGE_EDIT_COMMAND: 'edit --model editor --image-paths {image} --output {out}',
    } as NodeJS.ProcessEnv
    expect(resolveImageCommand(env)).toContain('gen')
    expect(resolveImageEditCommand(env)).toContain('edit')
    // 編集用の指定が無いときは、既定の編集コマンドか生成用へ落ちる。
    // どちらが出るかは端末に何が入っているかで変わるので、契約だけを確かめる
    const only = { PROVISION_IMAGE_COMMAND: 'gen --output {out}' } as NodeJS.ProcessEnv
    expect(resolveImageEditCommand(only)).toContain('{out}')
  })

  it('{out} を欠いた編集用コマンドを拒否する', () => {
    const env = {
      PROVISION_IMAGE_COMMAND: 'gen --output {out}',
      PROVISION_IMAGE_EDIT_COMMAND: 'edit --image-paths {image}',
    } as NodeJS.ProcessEnv
    expect(() => resolveImageEditCommand(env)).toThrow('{out}')
  })

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
    // 量子化まで含めないと、同じ重みでも別の絵になる組み合わせを区別できない
    expect(modelIdOf('mflux-generate-flux2-edit --model flux2-klein-4b --quantize 8')).toBe(
      'flux2-klein-4b-q8',
    )
    expect(modelIdOf('mflux-generate-kontext --model dev -q 4')).toBe('dev-q4')
    // パスへ既に焼き込まれているときは二重に付けない
    expect(modelIdOf('x --model ~/.cache/geologo/z-image-turbo-4bit --quantize 4')).toBe(
      'z-image-turbo-4bit',
    )
    expect(modelIdOf('/usr/local/bin/some-generator --output {out}')).toBe(
      'some-generator',
    )
  })
})
