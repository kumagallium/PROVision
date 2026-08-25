import { describe, expect, it } from 'vitest'
import { ProvGraph } from './graph.js'
import { toNTriples } from './ntriples.js'
import { fromProvJsonLd, toProvJsonLd } from './jsonld.js'
import { DEFAULT_BASE } from './iri.js'

const bytes = (s: string) => new TextEncoder().encode(s)

/** asterism 側に実在する形の IRI（デモの curve IRI に合わせた） */
const CURVE = 'https://kumagallium.github.io/asterism/starrydata/resource/curve/1-1-1'

function graphWithReference(): { graph: ProvGraph; figure: string } {
  const g = new ProvGraph()
  const tool = g.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
  const me = g.addAgent('kumagallium', 'kumagallium', 'Person')

  const v1 = g.recordGeneration({
    image: bytes('v1'),
    label: '概念図 v1',
    prompt: 'flat vector concept diagram of a thermoelectric module',
    model: 'z-image-turbo-4bit',
    seed: 42,
    startedAtTime: '2026-08-20T10:00:00Z',
    endedAtTime: '2026-08-20T10:00:12Z',
    // 著者がこの測定曲線を見て、この図を作らせた
    referenced: [CURVE],
    agents: [tool.id, me.id],
  })

  const v2 = g.recordGeneration({
    image: bytes('v2'),
    label: '概念図 v2',
    intent: 'もっと余白を取って',
    prompt: 'flat vector concept diagram ..., generous margins',
    model: 'z-image-turbo-4bit',
    seed: 43,
    startedAtTime: '2026-08-20T10:05:00Z',
    endedAtTime: '2026-08-20T10:05:11Z',
    derivedFrom: [v1.id],
    agents: [tool.id, me.id],
  })

  return { graph: g, figure: v2.id }
}

describe('外部リソースの参照', () => {
  it('参照は prov:used だけ。wasDerivedFrom は張らない', () => {
    const { graph } = graphWithReference()
    const lines = toNTriples(graph)

    const usedCurve = lines.filter((l) => l.includes('#used') && l.includes(CURVE))
    expect(usedCurve).toHaveLength(1)

    // 機械が消費したわけではないので、派生の辺は張らない
    const derivedFromCurve = lines.filter(
      (l) => l.includes('#wasDerivedFrom') && l.includes(CURVE),
    )
    expect(derivedFromCurve).toHaveLength(0)
  })

  it('責任者として人間 Agent が紐づく', () => {
    const { graph } = graphWithReference()
    const lines = toNTriples(graph)
    const person = graph.listAgents().find((a) => a.kind === 'Person')!
    expect(
      lines.some((l) => l.includes('#wasAssociatedWith') && l.includes(person.id)),
    ).toBe(true)
    expect(lines.some((l) => l.includes('#Person'))).toBe(true)
  })

  it('外部リソースにもノードを置く（viz が辺を描けるように）', () => {
    const { graph } = graphWithReference()
    const nodes = toProvJsonLd(graph)['@graph']
    const stub = nodes.find((n) => n['@id'] === CURVE)
    expect(stub).toBeDefined()
    expect(stub!['@type']).toBe('Entity')
    // 中身は主張しない。imageDigest はこちらの画像にしか付かない
    expect(stub!['provision:imageDigest']).toBeUndefined()
  })

  it('JSON-LD を往復しても派生元と参照が混ざらない', () => {
    const { graph } = graphWithReference()
    const restored = fromProvJsonLd(toProvJsonLd(graph), DEFAULT_BASE)
    expect(restored.toData()).toEqual(graph.toData())

    const root = restored.listActivities().find((a) => a.used.length === 0)!
    expect(root.referenced).toEqual([CURVE])
  })
})

describe('N-Triples', () => {
  it('決定論的に並ぶ（同じグラフからは同じ出力）', () => {
    const a = toNTriples(graphWithReference().graph)
    const b = toNTriples(graphWithReference().graph)
    expect(a).toEqual(b)
    expect(a).toEqual([...a].sort())
  })

  it('すべての行が N-Triples の形をしている', () => {
    for (const line of toNTriples(graphWithReference().graph)) {
      expect(line.endsWith(' .')).toBe(true)
      expect(line.startsWith('<')).toBe(true)
    }
  })

  it('リテラル中の引用符と改行を壊さない', () => {
    const g = new ProvGraph()
    g.recordGeneration({
      image: bytes('q'),
      label: 'quote',
      prompt: 'a "bold" diagram\nwith a newline',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:01Z',
    })
    const promptLine = toNTriples(g).find((l) => l.includes('#prompt'))!
    expect(promptLine).toContain('\\"bold\\"')
    expect(promptLine).toContain('\\n')
    expect(promptLine).not.toContain('\n')
  })

  it('編集用入力画像の来歴を書き出す', () => {
    const g = new ProvGraph()
    g.recordGeneration({
      image: bytes('edited'),
      label: '文字を消した案',
      prompt: 'Edit the selected region',
      model: 'z-image-turbo-4bit',
      seed: 42,
      imageStrength: 0.3,
      conditioningImageDigest: 'a'.repeat(64),
      conditioningImageLocation: 'images/aaaaaaaaaaaaaaaa.png',
      maskImageDigest: 'b'.repeat(64),
      maskImageLocation: 'images/bbbbbbbbbbbbbbbb.png',
      planningMode: 'rules',
      plannerProvider: 'openai-compatible',
      selectedTool: 'image.erase',
      toolArguments: '{}',
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:12Z',
    })

    const lines = toNTriples(g)
    expect(lines.some((line) => line.includes('#imageStrength') && line.includes('0.3'))).toBe(
      true,
    )
    expect(lines.some((line) => line.includes('#conditioningImageDigest'))).toBe(true)
    expect(lines.some((line) => line.includes('#conditioningImageLocation'))).toBe(true)
    expect(lines.some((line) => line.includes('#maskImageDigest'))).toBe(true)
    expect(lines.some((line) => line.includes('#maskImageLocation'))).toBe(true)
    expect(lines.some((line) => line.includes('#planningMode'))).toBe(true)
    expect(lines.some((line) => line.includes('#plannerProvider'))).toBe(true)
    expect(lines.some((line) => line.includes('#selectedTool'))).toBe(true)
    expect(lines.some((line) => line.includes('#toolArguments'))).toBe(true)
  })
})

describe('実行環境と再現等級を N-Triples へ出す（D-015 / D-016）', () => {
  it('asterism 側の SPARQL から環境と等級を引ける', () => {
    const g = new ProvGraph()
    const tool = g.addAgent('mflux-abc123', 'mflux 0.9.1', 'SoftwareAgent', {
      version: '0.9.1',
      modelFingerprint: 'f00dcafe',
      platform: 'Mac15,8 / Apple M3 Max / macOS 15.2',
    })
    g.recordGeneration({
      image: new TextEncoder().encode('nt-env'),
      label: '環境つきの版',
      prompt: 'a diagram',
      model: 'z-image-turbo-4bit',
      seed: 7,
      reproducibility: 'stochastic',
      pixelOrigin: 'synthesized',
      startedAtTime: '2026-08-25T10:00:00Z',
      endedAtTime: '2026-08-25T10:00:12Z',
      agents: [tool.id],
    })

    const text = toNTriples(g).join('\n')
    expect(text).toMatch(/version>\s+"0\.9\.1"/)
    expect(text).toMatch(/modelFingerprint>\s+"f00dcafe"/)
    expect(text).toMatch(/platform>\s+"Mac15,8 \/ Apple M3 Max \/ macOS 15\.2"/)
    expect(text).toMatch(/reproducibility>\s+"stochastic"/)
    expect(text).toMatch(/pixelOrigin>\s+"synthesized"/)
  })
})
