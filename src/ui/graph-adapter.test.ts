import { describe, expect, it } from 'vitest'
import { ProvGraph } from '../prov/graph.js'
import { executedPromptOf, imageUrlOf, toFlow } from './graph-adapter.js'

const bytes = (s: string) => new TextEncoder().encode(s)
const CURVE = 'https://kumagallium.github.io/asterism/starrydata/resource/curve/1171-318-665'

function branchingGraph() {
  const g = new ProvGraph()
  const tool = g.addAgent('mflux', 'mflux')
  const common = {
    prompt: 'p',
    model: 'm',
    startedAtTime: '2026-08-20T10:00:00Z',
    endedAtTime: '2026-08-20T10:00:10Z',
    agents: [tool.id],
  }
  const v1 = g.recordGeneration({
    ...common,
    image: bytes('v1'),
    label: 'v1',
    seed: 1,
    referenced: [CURVE],
    location: 'data/run/images/aaa.png',
  })
  const v2 = g.recordGeneration({
    ...common,
    image: bytes('v2'),
    label: 'v2',
    seed: 2,
    intent: '余白を',
    derivedFrom: [v1.id],
  })
  g.recordGeneration({
    ...common,
    image: bytes('v3a'),
    label: 'v3a',
    seed: 3,
    intent: '寒色に',
    derivedFrom: [v2.id],
  })
  g.recordGeneration({
    ...common,
    image: bytes('v3b'),
    label: 'v3b',
    seed: 4,
    intent: '単色に',
    derivedFrom: [v2.id],
  })
  return g
}

describe('React Flow への写し取り', () => {
  it('画像・生成・外部リソースがそれぞれノードになる', () => {
    const { nodes } = toFlow(branchingGraph())
    const count = (t: string) => nodes.filter((n) => n.type === t).length
    expect(count('image')).toBe(4)
    expect(count('activity')).toBe(4)
    expect(count('external')).toBe(1)
  })

  it('参照の辺は生成・派生の辺と区別される', () => {
    const { edges } = toFlow(branchingGraph())
    const kinds = edges.map((e) => e.data.kind)
    expect(kinds.filter((k) => k === 'referenced')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'generated')).toHaveLength(4)
    expect(kinds.filter((k) => k === 'used')).toHaveLength(3)
  })

  it('枝分かれが辺として現れる', () => {
    const g = branchingGraph()
    const { edges } = toFlow(g)
    const v2 = g.listEntities().find((e) => e.label === 'v2')!
    // v2 を使う生成が 2 本（v3a と v3b）
    expect(edges.filter((e) => e.source === v2.id && e.data.kind === 'used')).toHaveLength(2)
  })

  it('生成ノードの見出しは意図。初回だけ版の名前', () => {
    const { nodes } = toFlow(branchingGraph())
    const labels = nodes.filter((n) => n.type === 'activity').map((n) => n.data.label)
    expect(labels).toContain('余白を')
    expect(labels).toContain('寒色に')
    expect(labels).toContain('v1')
  })

  it('生成ノードは実行された全文（清書）を持ち、指示の節点から生えたことも分かる（D-030）', () => {
    const g = new ProvGraph()
    const tool = g.addAgent('mflux', 'mflux')
    const plan = g.addPlan('タコの 8 のアイコン', '2026-09-02T05:00:00Z')
    const common = {
      model: 'z-image-turbo-6bit',
      startedAtTime: '2026-09-02T05:00:00Z',
      endedAtTime: '2026-09-02T05:01:00Z',
      agents: [tool.id],
      intent: 'タコの 8 のアイコン',
      selectedTool: 'image.generate',
      planId: plan.id,
    }
    g.recordGeneration({
      ...common,
      image: bytes('a'),
      label: 'a',
      seed: 1,
      prompt: 'Flat vector badge with a circular outline, octopus head',
    })
    g.recordGeneration({
      ...common,
      image: bytes('b'),
      label: 'b',
      seed: 2,
      prompt: 'Flat vector monogram, the letter O shaped as an 8',
    })
    const { nodes } = toFlow(g)
    const activities = nodes.filter((n) => n.type === 'activity')
    // 兄弟は同じ意図を持つが、見せるべきはそれぞれの清書
    expect(activities.map((n) => n.data.prompt).sort()).toEqual([
      'Flat vector badge with a circular outline, octopus head',
      'Flat vector monogram, the letter O shaped as an 8',
    ])
    expect(activities.every((n) => n.data.planned === true)).toBe(true)
    expect(activities.every((n) => n.data.label === 'タコの 8 のアイコン')).toBe(true)
  })

  it('清書を使わない道具や、意図と同じ文しか無い記録には清書を付けない', () => {
    const base = {
      id: 'x',
      label: 'v',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-09-02T05:00:00Z',
      endedAtTime: '2026-09-02T05:01:00Z',
      used: [],
      referenced: [],
      generated: 'e',
      wasAssociatedWith: [],
    }
    // Jimp は画像モデルを使わない。記録された prompt は指示の写しにすぎない
    expect(
      executedPromptOf({ ...base, intent: '回転して', prompt: '回転して', selectedTool: 'image.rotate' }),
    ).toBeUndefined()
    expect(executedPromptOf({ ...base, prompt: '取り込み', selectedTool: 'image.import' })).toBeUndefined()
    // 道具が記録されていない古い版: 意図と同じ文なら出さない、違えば出す
    expect(executedPromptOf({ ...base, intent: '余白を', prompt: '余白を' })).toBeUndefined()
    expect(executedPromptOf({ ...base, intent: '余白を', prompt: 'wider margins' })).toBe('wider margins')
    // 1 本だけの送信（指示の節点なし）は planned にならない
    const { nodes } = toFlow(branchingGraph())
    expect(nodes.filter((n) => n.type === 'activity').every((n) => n.data.planned === false)).toBe(true)
  })

  it('画像の置き場所を配信 URL に直す', () => {
    expect(
      imageUrlOf({
        id: 'x',
        label: 'l',
        digest: 'd',
        mediaType: 'image/png',
        location: 'data/run/images/aaa.png',
      }),
    ).toBe('/api/images/aaa.png')
  })
})

describe('会話（根ごとの連結成分）', () => {
  it('根を持たない語彙を足さずに会話を切り出せる', () => {
    const g = branchingGraph()
    // もう 1 本、別の会話を足す
    const other = g.recordGeneration({
      image: bytes('kuma-1'),
      label: '熊のロゴ',
      prompt: 'a bear',
      model: 'm',
      seed: 9,
      startedAtTime: '2026-08-20T12:00:00Z',
      endedAtTime: '2026-08-20T12:00:10Z',
    })

    expect(g.roots()).toHaveLength(2)
    expect(g.session(other.id).map((e) => e.label)).toEqual(['熊のロゴ'])

    const first = g.roots().find((r) => r.label === 'v1')!
    expect(g.session(first.id).map((e) => e.label)).toEqual(['v1', 'v2', 'v3a', 'v3b'])
    expect(g.rootOf(g.listEntities().find((e) => e.label === 'v3b')!.id)).toBe(first.id)
  })

  it('真ん中の面には、いま話している会話だけを写す', () => {
    const g = branchingGraph()
    g.recordGeneration({
      image: bytes('kuma-1'),
      label: '熊のロゴ',
      prompt: 'a bear',
      model: 'm',
      seed: 9,
      startedAtTime: '2026-08-20T12:00:00Z',
      endedAtTime: '2026-08-20T12:00:10Z',
    })

    const first = g.roots().find((r) => r.label === 'v1')!
    const { nodes } = toFlow(g, first.id)
    expect(nodes.filter((n) => n.type === 'image')).toHaveLength(4)
    expect(nodes.some((n) => n.data.label === '熊のロゴ')).toBe(false)
    // 参照した外部リソースは、その会話のぶんだけ出る
    expect(nodes.filter((n) => n.type === 'external')).toHaveLength(1)
  })
})
