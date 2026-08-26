import { describe, expect, it } from 'vitest'
import { ProvGraph } from './graph.js'
import { alternatesOf, compareGenerations } from './compare.js'
import type { GenerationActivity } from './types.js'

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

describe('記録した項目の割り振り', () => {
  /**
   * **すべての項目に行き先を決める。** 記録はしているのに突き合わせにも画面にも
   * 出てこない項目が実際に生まれた（pixelOrigin と sourceFile* が 3 フェーズぶん漏れた）。
   *
   * `Required<GenerationActivity>` にしてあるので、**型へ項目を足した時点で
   * ここがコンパイルできなくなる**。そこで初めて「比べるのか、出さないのか」を決める
   */
  const complete: Required<GenerationActivity> = {
    id: 'urn:a',
    label: 'ラベル',
    prompt: 'prompt',
    model: 'model',
    seed: 1,
    startedAtTime: '2026-08-26T10:00:00Z',
    endedAtTime: '2026-08-26T10:00:10Z',
    intent: 'intent',
    negativePrompt: 'negative',
    imageStrength: 0.3,
    conditioningImageDigest: 'cond',
    conditioningImageLocation: 'images/cond.png',
    maskImageDigest: 'mask',
    maskImageLocation: 'images/mask.png',
    commandTemplate: 'cmd {out}',
    reproducibility: 'stochastic',
    pixelOrigin: 'synthesized',
    planningMode: 'rules',
    plannerProvider: 'openai-compatible',
    plannerModel: 'gpt',
    selectedTool: 'image.generate',
    toolArguments: '{}',
    sourceFileDigest: 'src',
    sourceFileMediaType: 'image/tiff',
    sourceFileName: 'figure.tif',
    provider: 'command:mflux',
    steps: 8,
    guidance: 3.5,
    width: 768,
    height: 768,
    planId: 'urn:plan',
    branchedFrom: 'urn:parent',
    used: [],
    referenced: [],
    generated: 'urn:e',
    wasAssociatedWith: [],
  }

  /** 突き合わせる項目（`ACTIVITY_FIELDS` と 1 対 1） */
  const COMPARED = [
    'prompt',
    'negativePrompt',
    'model',
    'provider',
    'seed',
    'steps',
    'guidance',
    'width',
    'imageStrength',
    'conditioningImageDigest',
    'maskImageDigest',
    'selectedTool',
    'toolArguments',
    'commandTemplate',
    'planningMode',
    'plannerModel',
    'reproducibility',
    'pixelOrigin',
    'sourceFileName',
    'sourceFileDigest',
    'sourceFileMediaType',
  ]

  /** 突き合わせない項目と、その理由 */
  const NOT_COMPARED: Record<string, string> = {
    id: 'IRI は中身から決まる。違えば中身が違うということで、差分にはならない',
    label: '表示名。絵には効かない',
    intent: '利用者の生の言葉。書き直しの差は prompt に出る',
    startedAtTime: '毎回違う。出すと差分の意味が消える',
    endedAtTime: '同上',
    height: 'width と一緒に size として 1 項目で見る',
    conditioningImageLocation: '場所は digest が同じなら同じもの',
    maskImageLocation: '同上',
    plannerProvider: 'plannerModel と一緒に見る',
    planId: 'どの送信から走ったか。絵には効かない（D-022）',
    used: '系譜の形。突き合わせるのは同じ指定の 2 版なので、ここは前提',
    branchedFrom: 'used のうち利用者が居た版。会話のたどり方であって、絵には効かない（D-021）',
    referenced: '人が見た外部データ。絵には効かない（D-006）',
    generated: '生まれた画像そのもの。違うから突き合わせている',
    wasAssociatedWith: 'Agent の層は AGENT_FIELDS で別に見る',
  }

  it('記録している項目は、比べるか・比べない理由があるかのどちらか', () => {
    for (const key of Object.keys(complete)) {
      const decided = COMPARED.includes(key) || key in NOT_COMPARED
      expect(decided, `${key} の行き先が決まっていない`).toBe(true)
    }
  })

  it('後から足した項目も実際に差分へ出る', () => {
    const g = new ProvGraph()
    const first = g.recordGeneration({
      image: bytes('cmp-1'),
      label: '取り込み',
      prompt: '取り込み',
      model: 'import',
      seed: 0,
      pixelOrigin: 'external',
      sourceFileName: 'a.tif',
      sourceFileDigest: 'aaa',
      startedAtTime: '2026-08-26T10:00:00Z',
      endedAtTime: '2026-08-26T10:00:00Z',
    })
    const second = g.recordGeneration({
      image: bytes('cmp-2'),
      label: '取り込み',
      prompt: '取り込み',
      model: 'import',
      seed: 0,
      pixelOrigin: 'geometric',
      sourceFileName: 'b.tif',
      sourceFileDigest: 'bbb',
      // Activity の IRI は再実行に要る情報と開始時刻から決まる。揃えると同じ IRI に畳まれる
      startedAtTime: '2026-08-26T11:00:00Z',
      endedAtTime: '2026-08-26T11:00:00Z',
      alternateOf: first.id,
    })
    const labels = compareGenerations(g, first.id, second.id).differences.map((d) => d.label)
    expect(labels).toContain('pixel origin')
    expect(labels).toContain('source file')
    expect(labels).toContain('source file sha256')
  })
})
