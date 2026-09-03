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

  it('アーカイブした版は、既定では印が付くだけ。隠すのは見る側が決める（D-032）', () => {
    const g = branchingGraph()
    const v3b = g.listEntities().find((e) => e.label === 'v3b')!
    g.assertArchived({ entity: v3b.id, archived: true, at: '2026-09-03T11:00:00Z' })

    const { nodes } = toFlow(g)
    expect(nodes.find((n) => n.id === v3b.id)!.data.archived).toBe(true)
    expect(nodes.filter((n) => n.type === 'image')).toHaveLength(4)
    expect(nodes.filter((n) => n.data.archived === true)).toHaveLength(1)
  })

  it('隠すよう頼まれたら、その版と生成の節点をグラフから外す（D-032）', () => {
    const g = branchingGraph()
    const v3b = g.listEntities().find((e) => e.label === 'v3b')!
    g.assertArchived({ entity: v3b.id, archived: true, at: '2026-09-03T11:00:00Z' })

    const { nodes, edges } = toFlow(g, undefined, { hideArchived: true })
    expect(nodes.some((n) => n.id === v3b.id)).toBe(false)
    // 生んだ生成の節点も一緒に消える。残すと、どこへも繋がらない札になる
    expect(nodes.filter((n) => n.type === 'image')).toHaveLength(3)
    expect(nodes.filter((n) => n.type === 'activity')).toHaveLength(3)
    expect(edges.every((e) => !e.id.includes(v3b.id))).toBe(true)
  })

  it('隠した版の子は、その上の見えている版へ繋ぎ直す（D-032）', () => {
    const g = branchingGraph()
    const v2 = g.listEntities().find((e) => e.label === 'v2')!
    const v1 = g.listEntities().find((e) => e.label === 'v1')!
    const v3a = g.listEntities().find((e) => e.label === 'v3a')!
    // 系譜の途中の版を隠す。子（v3a・v3b）は残る
    g.assertArchived({ entity: v2.id, archived: true, at: '2026-09-03T11:00:00Z' })

    const { nodes, edges } = toFlow(g, undefined, { hideArchived: true })
    const ids = new Set(nodes.map((n) => n.id))
    expect(ids.has(v2.id)).toBe(false)
    expect(ids.has(v3a.id)).toBe(true)
    // 辺ごと落とすと、子が「どこから来たか」を辿れなくなる。v1 へ繋ぎ直す
    const relinked = edges.filter((e) => e.data.kind === 'skipped')
    expect(relinked).toHaveLength(2)
    expect(relinked.every((e) => e.source === v1.id)).toBe(true)
    // 端点の無い辺は作らない（ELK が例外を投げてグラフが 1 本も描かれなくなる）
    expect(edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true)
  })

  it('根まで全部隠れているなら、子はそのまま根として描く（繋ぎ先が無い）', () => {
    const g = branchingGraph()
    const v1 = g.listEntities().find((e) => e.label === 'v1')!
    const v2 = g.listEntities().find((e) => e.label === 'v2')!
    for (const entity of [v1, v2]) {
      g.assertArchived({ entity: entity.id, archived: true, at: '2026-09-03T11:00:00Z' })
    }
    const { nodes, edges } = toFlow(g, undefined, { hideArchived: true })
    const ids = new Set(nodes.map((n) => n.id))
    expect(edges.filter((e) => e.data.kind === 'skipped')).toHaveLength(0)
    expect(edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true)
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
