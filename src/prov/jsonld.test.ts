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
