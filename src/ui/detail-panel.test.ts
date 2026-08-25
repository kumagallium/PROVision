import { describe, expect, it } from 'vitest'
import { ProvGraph } from '../prov/graph.js'
import { comparisonLines, pixelOriginLines, reproducibilityLines } from './detail-panel.js'

const bytes = (s: string) => new TextEncoder().encode(s)

/** Jimp で切ってから mflux で描き直した系譜を作る */
function mixedLineage() {
  const g = new ProvGraph()
  const jimp = g.addAgent('jimp-1', 'Jimp', 'SoftwareAgent', {
    platform: 'Mac15,8 / Apple M3 Max / macOS 15.2',
  })
  const mflux = g.addAgent('mflux-1', 'mflux', 'SoftwareAgent', {
    version: 'mflux 0.18.1, mlx 0.31.2',
    modelFingerprint: '2eeb1241',
    platform: 'Mac15,8 / Apple M3 Max / macOS 15.2',
  })

  const cropped = g.recordGeneration({
    image: bytes('cropped'),
    label: '正方形に切った版',
    prompt: 'crop',
    model: 'jimp',
    seed: 0,
    selectedTool: 'image.crop-square',
    reproducibility: 'deterministic',
    pixelOrigin: 'geometric',
    startedAtTime: '2026-08-25T10:00:00Z',
    endedAtTime: '2026-08-25T10:00:01Z',
    agents: [jimp.id],
  })
  const redrawn = g.recordGeneration({
    image: bytes('redrawn'),
    label: '描き直した版',
    prompt: 'redraw',
    model: 'z-image-turbo-4bit',
    seed: 7,
    selectedTool: 'image.edit',
    reproducibility: 'stochastic',
    pixelOrigin: 'synthesized',
    startedAtTime: '2026-08-25T10:01:00Z',
    endedAtTime: '2026-08-25T10:03:00Z',
    derivedFrom: [cropped.id],
    agents: [mflux.id],
  })
  return { g, cropped, redrawn }
}

describe('再現の範囲の表示（D-015 / D-016）', () => {
  it('確定的な一手なら、その旨と実行環境を出す', () => {
    const { g, cropped } = mixedLineage()
    const lines = reproducibilityLines(g, cropped.id)
    expect(lines[0]).toBe('この一手: どの PC でも同じ絵になる')
    expect(lines[1]).toBe('ここまでの系譜: どの PC でも同じ絵になる')
    expect(lines).toContain('Jimp: Mac15,8 / Apple M3 Max / macOS 15.2')
  })

  it('確率的な辺が 1 本混ざれば、系譜全体は再現しないと出す', () => {
    const { g, redrawn } = mixedLineage()
    const lines = reproducibilityLines(g, redrawn.id)
    expect(lines[0]).toBe('この一手: 環境が変わると絵も変わりうる')
    expect(lines[1]).toBe('ここまでの系譜: 環境が変わると絵も変わりうる')
    expect(lines).toContain(
      'mflux: version mflux 0.18.1, mlx 0.31.2 / model 2eeb1241 / Mac15,8 / Apple M3 Max / macOS 15.2',
    )
  })

  it('等級を足す前の版は、無印を「再現する」と読ませない', () => {
    const g = new ProvGraph()
    const old = g.recordGeneration({
      image: bytes('old'),
      label: '古い版',
      prompt: 'x',
      model: 'z-image-turbo-4bit',
      seed: 1,
      startedAtTime: '2026-08-01T10:00:00Z',
      endedAtTime: '2026-08-01T10:00:10Z',
    })
    expect(reproducibilityLines(g, old.id)).toEqual([
      '等級を記録する前の版なので、再現の範囲は分からない',
    ])
  })
})

describe('画素の由来の表示（D-020）', () => {
  it('画素を作っていない版は、本数と「では何をしたか」を出す', () => {
    const { g, cropped } = mixedLineage()
    expect(pixelOriginLines(g, cropped.id)).toEqual([
      'この一手: 位置と大きさを変えただけで、画素は作っていない',
      'ここまでの系譜: 1 本のうち、画素を作った手は 0 本',
    ])
  })

  it('生成が 1 本混ざれば本数に出る。0 と「見ていない」を混ぜない', () => {
    const { g, redrawn } = mixedLineage()
    expect(pixelOriginLines(g, redrawn.id)).toEqual([
      'この一手: 入力に無かった画素を作った',
      'ここまでの系譜: 2 本のうち、画素を作った手は 1 本',
    ])
  })

  it('取り込みを含む系譜では、手前が見えないことを必ず添える', () => {
    const g = new ProvGraph()
    const imported = g.recordGeneration({
      image: bytes('imported'),
      label: '取り込んだ版',
      prompt: 'import',
      model: 'import',
      seed: 0,
      selectedTool: 'image.import',
      pixelOrigin: 'external',
      startedAtTime: '2026-08-25T09:00:00Z',
      endedAtTime: '2026-08-25T09:00:00Z',
    })
    const cropped = g.recordGeneration({
      image: bytes('imported-cropped'),
      label: '切った版',
      prompt: 'crop',
      model: 'jimp',
      seed: 0,
      selectedTool: 'image.crop-square',
      pixelOrigin: 'geometric',
      startedAtTime: '2026-08-25T09:01:00Z',
      endedAtTime: '2026-08-25T09:01:01Z',
      derivedFrom: [imported.id],
    })
    expect(pixelOriginLines(g, cropped.id)).toEqual([
      'この一手: 位置と大きさを変えただけで、画素は作っていない',
      'ここまでの系譜: 2 本のうち、画素を作った手は 0 本',
      '取り込んだ画像より前は、この記録では見えない',
    ])
  })

  it('由来を足す前の版は、無印を「作っていない」と読ませない', () => {
    const g = new ProvGraph()
    const old = g.recordGeneration({
      image: bytes('old-origin'),
      label: '古い版',
      prompt: 'x',
      model: 'z-image-turbo-4bit',
      seed: 1,
      startedAtTime: '2026-08-01T10:00:00Z',
      endedAtTime: '2026-08-01T10:00:10Z',
    })
    expect(pixelOriginLines(g, old.id)).toEqual(['画素の由来を記録する前の版なので、分からない'])
  })
})

describe('食い違った版との差分の表示（D-015）', () => {
  function twoMachines() {
    const g = new ProvGraph()
    const onA = g.addAgent('mflux-aaa', 'mflux', 'SoftwareAgent', {
      role: 'mflux',
      version: 'mflux 0.18.1, mlx 0.31.2',
      platform: 'MacBookPro18,2 / Apple M1 Max / GPU 32-core / macOS 26.5.1 (25F80)',
    })
    const onB = g.addAgent('mflux-bbb', 'mflux', 'SoftwareAgent', {
      role: 'mflux',
      version: 'mflux 0.18.1, mlx 0.32.0',
      platform: 'MacBookPro18,2 / Apple M1 Max / GPU 32-core / macOS 26.5.1 (25F80)',
    })
    const spec = { prompt: 'a diagram', model: 'z-image-turbo-4bit', seed: 42 }
    const first = g.recordGeneration({
      ...spec,
      image: bytes('a'),
      label: '初回',
      startedAtTime: '2026-08-25T10:00:00Z',
      endedAtTime: '2026-08-25T10:02:00Z',
      agents: [onA.id],
    })
    const second = g.recordGeneration({
      ...spec,
      image: bytes('b'),
      label: '出し直した版',
      startedAtTime: '2026-08-26T10:00:00Z',
      endedAtTime: '2026-08-26T10:02:00Z',
      alternateOf: first.id,
      agents: [onB.id],
    })
    return { g, first, second }
  }

  it('違う項目だけを、どちらの値かが分かる形で並べる', () => {
    const { g, first, second } = twoMachines()
    const lines = comparisonLines(g, first.id, second.id)
    expect(lines[0]).toMatch(/^記録した \d+ 項目のうち 1 項目が違う。$/)
    expect(lines.join('\n')).toContain(
      'mflux version:\n  もう一方: mflux 0.18.1, mlx 0.31.2\n  この版:   mflux 0.18.1, mlx 0.32.0',
    )
  })

  it('原因だとは書かない。容疑者だと明示する（D-015 の非対称）', () => {
    const { g, first, second } = twoMachines()
    const text = comparisonLines(g, first.id, second.id).join('\n')
    expect(text).toContain('容疑者であって、絵が変わった原因が確かめられたわけではない')
    expect(text).not.toContain('原因は')
  })

  it('全項目が一致しても「環境が同一だった」とは書かない', () => {
    const g = new ProvGraph()
    const spec = { prompt: 'a diagram', model: 'm', seed: 42 }
    const first = g.recordGeneration({
      ...spec,
      image: bytes('a'),
      label: '初回',
      startedAtTime: '2026-08-25T10:00:00Z',
      endedAtTime: '2026-08-25T10:02:00Z',
    })
    const second = g.recordGeneration({
      ...spec,
      image: bytes('b'),
      label: '出し直した版',
      startedAtTime: '2026-08-26T10:00:00Z',
      endedAtTime: '2026-08-26T10:02:00Z',
      alternateOf: first.id,
    })
    const text = comparisonLines(g, first.id, second.id).join('\n')
    expect(text).toContain('項目はすべて一致した')
    expect(text).toContain('環境が同一だったとは言えない')
  })
})
