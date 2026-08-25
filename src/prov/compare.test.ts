import { describe, expect, it } from 'vitest'
import { ProvGraph } from './graph.js'
import { alternatesOf, compareGenerations } from './compare.js'

const bytes = (s: string) => new TextEncoder().encode(s)

const MAC_A = 'MacBookPro18,2 / Apple M1 Max / GPU 32-core / macOS 26.5.1 (25F80)'
const MAC_B = 'Mac15,8 / Apple M3 Max / GPU 40-core / macOS 26.5.1 (25F80)'

/**
 * 同じ指定を 2 台で走らせて食い違った状況を作る。
 * 違うのは platform と mlx の版だけで、指定の層は完全に同じ。
 */
function twoMachines() {
  const g = new ProvGraph()
  const onA = g.addAgent('mflux-aaa', 'mflux', 'SoftwareAgent', {
    role: 'mflux',
    version: 'mflux 0.18.1, mlx 0.31.2, python 3.13',
    modelFingerprint: '2eeb1241',
    platform: MAC_A,
  })
  const onB = g.addAgent('mflux-bbb', 'mflux', 'SoftwareAgent', {
    role: 'mflux',
    version: 'mflux 0.18.1, mlx 0.32.0, python 3.13',
    modelFingerprint: '2eeb1241',
    platform: MAC_B,
  })

  const spec = {
    prompt: 'a minimal concept diagram',
    model: 'z-image-turbo-4bit',
    seed: 42,
    steps: 8,
    width: 1024,
    height: 1024,
    selectedTool: 'image.generate',
    reproducibility: 'stochastic' as const,
    commandTemplate: '~/.local/bin/mflux-generate-z-image-turbo --model ~/.cache/z-image-turbo-4bit',
  }

  const first = g.recordGeneration({
    ...spec,
    image: bytes('from-mac-a'),
    label: '初回',
    startedAtTime: '2026-08-25T10:00:00Z',
    endedAtTime: '2026-08-25T10:02:00Z',
    agents: [onA.id],
  })
  const second = g.recordGeneration({
    ...spec,
    image: bytes('from-mac-b'),
    label: '別の Mac で出し直した版',
    startedAtTime: '2026-08-26T10:00:00Z',
    endedAtTime: '2026-08-26T10:02:00Z',
    alternateOf: first.id,
    agents: [onB.id],
  })
  return { g, first, second }
}

describe('compareGenerations', () => {
  it('指定が同じで環境だけ違うとき、環境の差だけを挙げる', () => {
    const { g, first, second } = twoMachines()
    const result = compareGenerations(g, first.id, second.id)

    expect(result.differences.map((d) => d.label)).toEqual([
      'mflux version',
      'mflux platform',
    ])
    expect(result.differences[0]).toMatchObject({
      left: 'mflux 0.18.1, mlx 0.31.2, python 3.13',
      right: 'mflux 0.18.1, mlx 0.32.0, python 3.13',
      oneSided: false,
    })
    // 重みは同じ。ここが一致していることも切り分けに要る情報
    expect(result.differences.map((d) => d.label)).not.toContain('mflux model fingerprint')
  })

  it('見た項目の数も返す。0 件のときに「何件見て 0 件か」が言えるように', () => {
    const { g, first, second } = twoMachines()
    expect(compareGenerations(g, first.id, second.id).compared).toBeGreaterThan(16)
  })

  it('環境ごとに IRI が変わっても、role で同じツールとして突き合わせる', () => {
    const { g, first, second } = twoMachines()
    const labels = compareGenerations(g, first.id, second.id).differences.map((d) => d.label)
    // role で対応付かないと、両側が別ツール扱いになって片側だけの行が並ぶ
    expect(labels.every((l) => l.startsWith('mflux '))).toBe(true)
  })

  it('片側にしか記録が無い項目は oneSided として区別する。値の相違と混ぜない', () => {
    const g = new ProvGraph()
    const base = { prompt: 'x', model: 'm', seed: 1, endedAtTime: '2026-08-25T10:00:10Z' }
    // Activity の IRI は開始時刻を含む。同じにすると 2 件が 1 件に潰れる
    const older = g.recordGeneration({
      ...base,
      image: bytes('old'),
      label: '古い版',
      startedAtTime: '2026-08-25T10:00:00Z',
    })
    const newer = g.recordGeneration({
      ...base,
      image: bytes('new'),
      label: '新しい版',
      startedAtTime: '2026-08-26T10:00:00Z',
      commandTemplate: '~/.local/bin/mflux-generate-z-image-turbo',
      alternateOf: older.id,
    })

    const command = compareGenerations(g, older.id, newer.id).differences.find(
      (d) => d.label === 'command',
    )
    expect(command).toMatchObject({ left: undefined, oneSided: true })
  })

  it('両側とも記録が無い項目は差分に出さない。比べていないものを差分と呼ばない', () => {
    const { g, first, second } = twoMachines()
    const labels = compareGenerations(g, first.id, second.id).differences.map((d) => d.label)
    expect(labels).not.toContain('negative prompt')
    expect(labels).not.toContain('mask image')
  })

  it('生成の記録が無い版は突き合わせられない。黙って 0 件を返さない', () => {
    const { g, first } = twoMachines()
    const result = compareGenerations(g, first.id, 'https://example.org/entity/none')
    expect(result.unavailable).toBeDefined()
    expect(result.differences).toEqual([])
  })
})

describe('alternatesOf', () => {
  it('alternateOf は新→旧の 1 方向だが、どちらを選んでも相手が見つかる', () => {
    const { g, first, second } = twoMachines()
    expect(alternatesOf(g, second.id)).toEqual([first.id])
    expect(alternatesOf(g, first.id)).toEqual([second.id])
  })

  it('食い違った相手がいなければ空', () => {
    const { g } = twoMachines()
    expect(alternatesOf(g, 'https://example.org/entity/none')).toEqual([])
  })
})
