import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STEPS,
  cacheKeyOf,
  modelIdOf,
  resolveImageCommand,
  resolveImageCommandForModel,
  resolveImageEditCommand,
} from './mflux.js'

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

describe('生成の既定値', () => {
  const base = { prompt: 'a logo', seed: 1 }

  it('省略時の鍵が 768x768 を明示したときと一致する', () => {
    // 鍵の計算と実行が別々に既定値を持つと、鍵だけ合って中身が違う絵を
    // キャッシュから返してしまう。同じ定数を見ていることを固定する
    expect(cacheKeyOf(base, 'm')).toBe(
      cacheKeyOf({ ...base, width: 768, height: 768, steps: DEFAULT_STEPS }, 'm'),
    )
  })

  it('サイズが違えば別の鍵になる', () => {
    expect(cacheKeyOf(base, 'm')).not.toBe(cacheKeyOf({ ...base, width: 1024 }, 'm'))
  })
})

describe('モデル識別子', () => {
  it('量子化の違いを識別子に残す', () => {
    // 6bit と 4bit は別の絵を出す。同じ名前で記録すると再現の突き合わせが嘘になる
    const of = (dir: string) =>
      modelIdOf(`/bin/mflux-generate-z-image-turbo --model /Users/x/.cache/geologo/${dir} --output {out}`)
    expect(of('z-image-turbo-6bit')).toBe('z-image-turbo-6bit')
    expect(of('z-image-turbo-4bit')).toBe('z-image-turbo-4bit')
    expect(of('z-image-turbo-6bit')).not.toBe(of('z-image-turbo-4bit'))
  })
})

describe('再実行のモデル固定', () => {
  const envWith = (dir: string) =>
    ({
      PROVISION_IMAGE_COMMAND: `/bin/gen --model /Users/x/.cache/provision/${dir} --output {out}`,
    }) as NodeJS.ProcessEnv

  it('いまの既定が記録と同じなら、それをそのまま使う', () => {
    const env = envWith('z-image-turbo-4bit')
    expect(resolveImageCommandForModel('z-image-turbo-4bit', { edit: false, env })).toContain(
      'z-image-turbo-4bit',
    )
  })

  it('記録されたモデルが手元に無ければ、黙って別のモデルで走らせずに止まる', () => {
    // 既定を差し替えたあと、昔の版を「食い違った」と誤って記録しないための砦
    const env = envWith('z-image-turbo-6bit')
    expect(() =>
      resolveImageCommandForModel('z-image-turbo-9bit', { edit: false, env }),
    ).toThrow(/z-image-turbo-9bit/)
  })
})

describe('編集モデルの識別子', () => {
  it('事前保存版と毎回量子化で、記録される識別子が同じになる', () => {
    // 実測で画素まで完全一致する同じ重み・同じ量子化なので、綴りが割れると
    // 同じものを別モデルとして記録し、過去の版の再現が通らなくなる
    const onTheFly = modelIdOf(
      '/bin/mflux-generate-flux2-edit --model flux2-klein-4b --quantize 8 --output {out}',
    )
    const preSaved = modelIdOf(
      '/bin/mflux-generate-flux2-edit --model /Users/x/.cache/provision/flux2-klein-4b-q8 ' +
        '--base-model flux2-klein-4b --output {out}',
    )
    expect(onTheFly).toBe('flux2-klein-4b-q8')
    expect(preSaved).toBe(onTheFly)
  })
})
