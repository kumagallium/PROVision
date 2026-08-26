import { describe, expect, it } from 'vitest'
import { ProvGraph } from './graph.js'
import { fromProvJsonLd, toProvJsonLd, PROVISION_CONTEXT_URL } from './jsonld.js'
import type { JsonLdNode } from './jsonld.js'
import { DEFAULT_BASE } from './iri.js'

const bytes = (s: string) => new TextEncoder().encode(s)

function sampleGraph(): ProvGraph {
  const g = new ProvGraph()
  const tool = g.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
  const me = g.addAgent('kumagallium', 'kumagallium', 'Person')

  const g1 = g.recordGeneration({
    image: bytes('gen-1'),
    label: '第 1 案',
    prompt: 'a minimal concept diagram of a thermoelectric module',
    model: 'z-image-turbo-4bit',
    seed: 42,
    steps: 8,
    width: 1024,
    height: 1024,
    provider: 'command:mflux',
    startedAtTime: '2026-08-20T10:00:00Z',
    endedAtTime: '2026-08-20T10:00:12Z',
    agents: [tool.id, me.id],
  })

  const g2 = g.recordGeneration({
    image: bytes('gen-2'),
    label: '余白を広げた案',
    intent: 'もっと余白を取って',
    prompt: 'a minimal concept diagram ..., generous margins',
    model: 'z-image-turbo-4bit',
    seed: 43,
    startedAtTime: '2026-08-20T10:05:00Z',
    endedAtTime: '2026-08-20T10:05:11Z',
    derivedFrom: [g1.id],
    agents: [tool.id, me.id],
  })

  g.recordGeneration({
    image: bytes('gen-3'),
    label: '寒色にした案',
    intent: '配色を寒色に寄せて',
    prompt: 'a minimal concept diagram ..., generous margins, cool palette',
    model: 'z-image-turbo-4bit',
    seed: 44,
    startedAtTime: '2026-08-20T10:09:00Z',
    endedAtTime: '2026-08-20T10:09:10Z',
    derivedFrom: [g2.id],
    agents: [tool.id, me.id],
  })

  return g
}

const byType = (nodes: JsonLdNode[], type: string) =>
  nodes.filter((n) => n['@type'] === type)

describe('PROV-JSONLD', () => {
  it('同じ絵に行き着いた Activity を全部 wasGeneratedBy に出す', () => {
    const g = new ProvGraph()
    const parent = g.recordGeneration({
      image: new TextEncoder().encode('root'),
      label: '根',
      prompt: 'root',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:01Z',
    })
    const common = {
      image: new TextEncoder().encode('same-output'),
      label: 'ワードマーク',
      model: 'jimp-1.6.1',
      seed: 0,
      derivedFrom: [parent.id],
    }
    g.recordGeneration({
      ...common,
      prompt: '「asterism」というロゴタイプを付けて',
      startedAtTime: '2026-08-20T11:00:00Z',
      endedAtTime: '2026-08-20T11:00:01Z',
    })
    const entity = g.recordGeneration({
      ...common,
      prompt: 'ロゴタイプを付けて',
      startedAtTime: '2026-08-20T12:00:00Z',
      endedAtTime: '2026-08-20T12:00:01Z',
    })
    const doc = toProvJsonLd(g) as { '@graph': Array<Record<string, unknown>> }
    const node = doc['@graph'].find((n) => n['@id'] === entity.id)!
    const by = node.wasGeneratedBy as Array<{ '@id': string }>
    expect(by).toHaveLength(2)
  })

  it('素の PROV を @vocab に置き、provision だけ拡張として足す', () => {
    const doc = toProvJsonLd(sampleGraph())
    const ctx = doc['@context'] as unknown[]
    expect(ctx[0]).toEqual({ '@vocab': 'http://www.w3.org/ns/prov#' })
    expect(ctx).toContain(PROVISION_CONTEXT_URL)
    // 他ドメインの語彙は混ぜない
    expect(JSON.stringify(ctx)).not.toContain('matprov')
  })

  it('prov-jsonld-viz が辺を描ける形になっている', () => {
    const nodes = toProvJsonLd(sampleGraph())['@graph']

    // viz は Usage / Generation / Association を見て辺を作る
    expect(byType(nodes, 'Usage')).toHaveLength(2)
    expect(byType(nodes, 'Generation')).toHaveLength(3)
    expect(byType(nodes, 'Association')).toHaveLength(6)

    // viz は item.entity / item.activity / item.agent を素の文字列として読む
    for (const n of [...byType(nodes, 'Usage'), ...byType(nodes, 'Generation')]) {
      expect(typeof n.activity).toBe('string')
      expect(typeof n.entity).toBe('string')
    }
    for (const n of byType(nodes, 'Association')) {
      expect(typeof n.agent).toBe('string')
    }

    // label は [{ "@value": ... }] 形式
    const entity = byType(nodes, 'Entity')[0]!
    expect(Array.isArray(entity.label)).toBe(true)
    expect((entity.label as JsonLdNode[])[0]!['@value']).toBeTypeOf('string')
  })

  it('素の PROV プロパティも Entity / Activity に持たせる（SPARQL 用）', () => {
    const nodes = toProvJsonLd(sampleGraph())['@graph']
    const derived = byType(nodes, 'Entity').filter((n) => n.wasDerivedFrom !== undefined)
    expect(derived).toHaveLength(2)
    for (const n of byType(nodes, 'Entity')) {
      expect(n.wasGeneratedBy).toBeDefined()
    }
    // 関係ノードに @id は付けない（付けると viz が孤立ノードとして描く）
    for (const t of ['Usage', 'Generation', 'Association']) {
      for (const n of byType(nodes, t)) expect(n['@id']).toBeUndefined()
    }
  })

  it('書き出して読み戻すとグラフが一致する', () => {
    const original = sampleGraph()
    const restored = fromProvJsonLd(toProvJsonLd(original), DEFAULT_BASE)
    expect(restored.toData()).toEqual(original.toData())
  })

  it('編集用入力画像の来歴を往復できる', () => {
    const graph = new ProvGraph()
    graph.recordGeneration({
      image: bytes('edited'),
      label: '文字を消した案',
      intent: 'ロゴタイプを消す',
      prompt: 'Edit the selected region',
      model: 'z-image-turbo-4bit',
      seed: 42,
      imageStrength: 0.3,
      conditioningImageDigest: 'a'.repeat(64),
      conditioningImageLocation: 'images/aaaaaaaaaaaaaaaa.png',
      maskImageDigest: 'b'.repeat(64),
      maskImageLocation: 'images/bbbbbbbbbbbbbbbb.png',
      planningMode: 'llm',
      plannerProvider: 'openai-compatible',
      plannerModel: 'qwen2.5:3b',
      selectedTool: 'image.erase',
      toolArguments: '{}',
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:12Z',
    })

    const restored = fromProvJsonLd(toProvJsonLd(graph), DEFAULT_BASE)
    const activity = restored.listActivities()[0]!
    expect(activity.imageStrength).toBe(0.3)
    expect(activity.conditioningImageDigest).toBe('a'.repeat(64))
    expect(activity.conditioningImageLocation).toBe('images/aaaaaaaaaaaaaaaa.png')
    expect(activity.maskImageDigest).toBe('b'.repeat(64))
    expect(activity.maskImageLocation).toBe('images/bbbbbbbbbbbbbbbb.png')
    expect(activity.planningMode).toBe('llm')
    expect(activity.plannerProvider).toBe('openai-compatible')
    expect(activity.plannerModel).toBe('qwen2.5:3b')
    expect(activity.selectedTool).toBe('image.erase')
    expect(activity.toolArguments).toBe('{}')
  })

  it('読み戻したグラフでも系譜を辿れる', () => {
    const original = sampleGraph()
    const restored = fromProvJsonLd(toProvJsonLd(original), DEFAULT_BASE)
    const leaf = restored.listEntities().find((e) => restored.children(e.id).length === 0)!
    expect(restored.lineage(leaf.id).map((a) => a.intent)).toEqual([
      undefined,
      'もっと余白を取って',
      '配色を寒色に寄せて',
    ])
  })
})

describe('実行環境と再現等級（D-015 / D-016）', () => {
  function envGraph(): ProvGraph {
    const g = new ProvGraph()
    const tool = g.addAgent('mflux-abc123', 'mflux 0.9.1', 'SoftwareAgent', {
      version: '0.9.1',
      modelFingerprint: 'f00dcafe',
      platform: 'Mac15,8 / Apple M3 Max / macOS 15.2',
    })
    g.recordGeneration({
      image: bytes('env-1'),
      label: '環境つきの版',
      prompt: 'a diagram',
      model: 'z-image-turbo-4bit',
      seed: 7,
      selectedTool: 'image.generate',
      reproducibility: 'stochastic',
      pixelOrigin: 'synthesized',
      startedAtTime: '2026-08-25T10:00:00Z',
      endedAtTime: '2026-08-25T10:00:12Z',
      agents: [tool.id],
    })
    return g
  }

  it('実行環境と等級が JSON-LD を往復しても消えない', () => {
    const back = fromProvJsonLd(toProvJsonLd(envGraph()), DEFAULT_BASE)
    const agent = back.listAgents().find((a) => a.version)
    expect(agent?.version).toBe('0.9.1')
    expect(agent?.modelFingerprint).toBe('f00dcafe')
    expect(agent?.platform).toBe('Mac15,8 / Apple M3 Max / macOS 15.2')
    expect(back.listActivities()[0]?.reproducibility).toBe('stochastic')
    expect(back.listActivities()[0]?.pixelOrigin).toBe('synthesized')
  })

  it('実測できなかった項目は書き出さない。空欄と未調査を区別できなくしない', () => {
    const g = new ProvGraph()
    g.addAgent('jimp', 'Jimp')
    const node = toProvJsonLd(g)['@graph'].find((n: JsonLdNode) => n['@type'] === 'SoftwareAgent')
    expect(node).toBeDefined()
    expect(node!['provision:version']).toBeUndefined()
    expect(node!['provision:platform']).toBeUndefined()
  })

  it('知らない等級は読み戻さない。語彙の外の値をグラフへ通さない', () => {
    const doc = toProvJsonLd(envGraph())
    for (const n of doc['@graph']) {
      if (n['provision:reproducibility']) n['provision:reproducibility'] = 'まあまあ再現する'
    }
    expect(fromProvJsonLd(doc, DEFAULT_BASE).listActivities()[0]?.reproducibility).toBeUndefined()
  })

  it('知らない画素の由来も読み戻さない（D-020）', () => {
    const doc = toProvJsonLd(envGraph())
    for (const n of doc['@graph']) {
      if (n['provision:pixelOrigin']) n['provision:pixelOrigin'] = 'ちょっと描いた'
    }
    expect(fromProvJsonLd(doc, DEFAULT_BASE).listActivities()[0]?.pixelOrigin).toBeUndefined()
  })
})
