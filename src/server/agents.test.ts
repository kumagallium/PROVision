import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { ProvGraph } from '../prov/graph.js'
import { addSoftwareAgent, agentLabel, agentSlug, commandTemplateOf } from './agents.js'

const MAC_A = 'MacBookPro18,2 / Apple M1 Max / GPU 32-core / macOS 26.5.1 (25F80)'
const MAC_B = 'Mac15,8 / Apple M3 Max / GPU 40-core / macOS 26.5.1 (25F80)'

describe('agentSlug', () => {
  it('環境が変われば別の slug になる。過去の Activity を今の版で作ったことにしない', () => {
    const before = agentSlug('mflux', { version: 'mflux 0.18.1', platform: MAC_A })
    const after = agentSlug('mflux', { version: 'mflux 0.19.0', platform: MAC_A })
    expect(before).not.toBe(after)
    expect(before.startsWith('mflux-')).toBe(true)
  })

  it('重みが差し替わっただけでも別の slug になる', () => {
    const a = agentSlug('mflux', { modelFingerprint: 'aaaa' })
    const b = agentSlug('mflux', { modelFingerprint: 'bbbb' })
    expect(a).not.toBe(b)
  })

  it('同じ環境なら同じ slug。走らせるたびに Agent が増えない', () => {
    const env = { version: 'mflux 0.18.1', modelFingerprint: 'aaaa', platform: MAC_A }
    expect(agentSlug('mflux', env)).toBe(agentSlug('mflux', env))
  })

  it('何も実測できなければ素の slug。既存のグラフと繋がる形を保つ', () => {
    expect(agentSlug('jimp', {})).toBe('jimp')
    expect(agentSlug('jimp', { version: undefined, platform: undefined })).toBe('jimp')
  })
})

describe('agentLabel', () => {
  it('版はツール名込みの文字列なので、区切って並べる（連結すると二重になる）', () => {
    expect(agentLabel('mflux (z-image-turbo-4bit)', { version: 'mflux 0.18.1, mlx 0.31.2' })).toBe(
      'mflux (z-image-turbo-4bit) — mflux 0.18.1, mlx 0.31.2',
    )
  })

  it('版が取れなければラベルだけ', () => {
    expect(agentLabel('Jimp', { platform: MAC_A })).toBe('Jimp')
  })
})

describe('addSoftwareAgent', () => {
  it('環境をまたいで同じツールだと言えるように role を必ず載せる', () => {
    const g = new ProvGraph()
    const a = addSoftwareAgent(g, 'mflux', 'mflux', { version: 'mflux 0.18.1', platform: MAC_A })
    const b = addSoftwareAgent(g, 'mflux', 'mflux', { version: 'mflux 0.19.0', platform: MAC_B })
    expect(a.id).not.toBe(b.id)
    expect(a.role).toBe('mflux')
    expect(b.role).toBe('mflux')
  })
})

describe('commandTemplateOf', () => {
  // normalizeHome は実行中の利用者のホームを畳む。fixture もそれに合わせる
  const home = homedir()
  const resolvers = {
    generate: () => `${home}/.local/bin/mflux-generate-z-image-turbo --steps 8`,
    edit: () => `${home}/.local/bin/mflux-generate-flux2-edit --image-paths {image}`,
    inpaint: () => `${home}/.local/bin/iopaint run --model lama`,
    background: () => `${home}/.local/bin/rembg i`,
  }

  it('入力画像があれば編集用、無ければ生成用を選ぶ（別コマンド＝別モデル）', () => {
    expect(commandTemplateOf('image.edit', true, resolvers)).toContain('flux2-edit')
    expect(commandTemplateOf('image.generate', false, resolvers)).toContain('z-image-turbo')
  })

  it('executor ごとに正しい解決先へ振る', () => {
    expect(commandTemplateOf('image.erase', true, resolvers)).toContain('iopaint')
    expect(commandTemplateOf('background.remove', true, resolvers)).toContain('rembg')
  })

  it('Jimp は外部コマンドを呼ばないので記録するものが無い', () => {
    expect(commandTemplateOf('image.rotate', true, resolvers)).toBeUndefined()
    expect(commandTemplateOf('image.wordmark', true, resolvers)).toBeUndefined()
  })

  it('ホームは ~ に畳む。書き出したファイルに利用者名を混ぜない', () => {
    const template = commandTemplateOf('image.generate', false, resolvers)!
    expect(template.startsWith('~/')).toBe(true)
    expect(template).not.toContain(home)
  })

  it('テンプレートが解決できなければ undefined。生成を止めるのは別の場所の仕事', () => {
    const broken = {
      ...resolvers,
      generate: () => {
        throw new Error('画像生成コマンドが見つからない')
      },
    }
    expect(commandTemplateOf('image.generate', false, broken)).toBeUndefined()
  })
})
