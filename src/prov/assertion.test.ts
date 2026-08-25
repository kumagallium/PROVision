import { describe, expect, it } from 'vitest'
import { ProvGraph } from './graph.js'
import { fromProvJsonLd, toProvJsonLd } from './jsonld.js'
import { toNTriples } from './ntriples.js'
import { DEFAULT_BASE } from './iri.js'

const bytes = (s: string) => new TextEncoder().encode(s)
const CURVE = 'https://kumagallium.github.io/asterism/starrydata/resource/curve/1171-318-665'
const DOI = 'https://doi.org/10.1021/ic800772m'

function graphWithTwoVersions() {
  const g = new ProvGraph()
  const me = g.addAgent('kumagallium', 'kumagallium', 'Person')
  const v1 = g.recordGeneration({
    image: bytes('v1'),
    label: 'v1',
    prompt: 'p',
    model: 'm',
    seed: 1,
    startedAtTime: '2026-08-20T10:00:00Z',
    endedAtTime: '2026-08-20T10:00:10Z',
    agents: [me.id],
  })
  const v2 = g.recordGeneration({
    image: bytes('v2'),
    label: 'v2',
    intent: '線を太く',
    prompt: 'p, thick',
    model: 'm',
    seed: 2,
    derivedFrom: [v1.id],
    startedAtTime: '2026-08-20T10:05:00Z',
    endedAtTime: '2026-08-20T10:05:10Z',
    agents: [me.id],
  })
  return { g, v1, v2, me }
}

describe('後から表明したこと', () => {
  it('参照は既存の記録を書き換えず、別の Activity として残る', () => {
    const { g, v1 } = graphWithTwoVersions()
    const before = JSON.stringify(g.listActivities())

    const a = g.assertReference({
      about: v1.id,
      referenced: [CURVE],
      at: '2026-08-21T09:00:00Z',
    })

    expect(a.kind).toBe('reference')
    // 生成の記録は 1 文字も変わっていない
    expect(JSON.stringify(g.listActivities())).toBe(before)
    expect(g.listAssertions()).toHaveLength(1)
  })

  it('系譜をさかのぼって、その版が基づくデータを集める', () => {
    const { g, v1, v2 } = graphWithTwoVersions()
    g.assertReference({ about: v1.id, referenced: [CURVE], at: '2026-08-21T09:00:00Z' })
    // 親に付けた参照は、子の版にも効く
    expect(g.referencesOf(v2.id)).toEqual([CURVE])
    expect(g.referencesOf(v1.id)).toEqual([CURVE])
  })

  it('掲載は fabio:Figure として書き出され、載った版から派生する', () => {
    const { g, v2, me } = graphWithTwoVersions()
    const a = g.assertPublication({
      about: v2.id,
      figureLabel: 'Figure 2',
      partOf: DOI,
      at: '2026-08-21T09:30:00Z',
      agents: [me.id],
    })

    expect(a.figure?.id).toBe(`${DOI}#figure-2`)
    expect(g.publicationsOf(v2.id).map((f) => f.label)).toEqual(['Figure 2'])

    const lines = toNTriples(g)
    expect(lines.some((l) => l.includes('spar/fabio/Figure'))).toBe(true)
    expect(
      lines.some((l) => l.includes('#wasDerivedFrom') && l.includes(v2.id) && l.startsWith(`<${DOI}#figure-2>`)),
    ).toBe(true)
    expect(lines.some((l) => l.includes('dc/terms/isPartOf') && l.includes(DOI))).toBe(true)
  })

  it('掲載先と呼び名が同じなら、誰が記録しても同じ figure の IRI になる', () => {
    const { g, v2 } = graphWithTwoVersions()
    const a = g.assertPublication({
      about: v2.id,
      figureLabel: 'Figure 2',
      partOf: DOI,
      at: '2026-08-21T09:30:00Z',
    })
    const b = g.assertPublication({
      about: v2.id,
      figureLabel: ' figure 2 ',
      partOf: `${DOI}#something`,
      at: '2026-08-21T10:00:00Z',
    })
    expect(b.figure?.id).toBe(a.figure?.id)
  })

  it('JSON-LD を往復しても表明が保たれる', () => {
    const { g, v1, v2, me } = graphWithTwoVersions()
    g.assertReference({
      about: v1.id,
      referenced: [CURVE],
      at: '2026-08-21T09:00:00Z',
      agents: [me.id],
    })
    g.assertPublication({
      about: v2.id,
      figureLabel: 'Figure 2',
      partOf: DOI,
      at: '2026-08-21T09:30:00Z',
      agents: [me.id],
    })

    const restored = fromProvJsonLd(toProvJsonLd(g), DEFAULT_BASE)
    expect(restored.toData()).toEqual(g.toData())
    expect(restored.referencesOf(v2.id)).toEqual([CURVE])
    expect(restored.publicationsOf(v2.id)[0]?.partOf).toBe(DOI)
  })

  it('改名しても、最初に打った指示は残る', () => {
    const { g, v1 } = graphWithTwoVersions()
    const firstIntent = g.activityThatGenerated(v1.id)!.label

    g.assertTitle({ root: v1.id, title: 'Asterism のロゴ', at: '2026-08-21T09:00:00Z' })
    expect(g.titleOf(v1.id)).toBe('Asterism のロゴ')
    // 生成の記録は変わらない
    expect(g.activityThatGenerated(v1.id)!.label).toBe(firstIntent)

    // 付け直すと新しいほうが効き、履歴は両方残る
    g.assertTitle({ root: v1.id, title: '星座ロゴ', at: '2026-08-21T10:00:00Z' })
    expect(g.titleOf(v1.id)).toBe('星座ロゴ')
    expect(g.listAssertions().filter((a) => a.kind === 'title')).toHaveLength(2)
  })

  it('会話を消すと、その会話のものだけが消える', () => {
    const { g, v1, v2 } = graphWithTwoVersions()
    g.assertReference({ about: v1.id, referenced: [CURVE], at: '2026-08-21T09:00:00Z' })

    // 別の会話を足しておく
    const other = g.recordGeneration({
      image: bytes('other'),
      label: '別の会話',
      prompt: 'p2',
      model: 'm',
      seed: 9,
      startedAtTime: '2026-08-20T12:00:00Z',
      endedAtTime: '2026-08-20T12:00:10Z',
    })

    const { removedImages } = g.deleteSession(v1.id)
    expect(removedImages).toEqual([])
    expect(g.getEntity(v1.id)).toBeUndefined()
    expect(g.getEntity(v2.id)).toBeUndefined()
    expect(g.listAssertions()).toHaveLength(0)
    // 別の会話は無傷
    expect(g.getEntity(other.id)).toBeDefined()
    expect(g.roots()).toHaveLength(1)
  })

  it('消した会話の画像は、消す対象として返る', () => {
    const g = new ProvGraph()
    const e = g.recordGeneration({
      image: bytes('x'),
      label: 'x',
      location: 'images/abc.png',
      prompt: 'p',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:10Z',
    })
    expect(g.deleteSession(e.id).removedImages).toEqual(['images/abc.png'])
  })

  it('消した会話の編集用入力画像も対象として返る', () => {
    const g = new ProvGraph()
    const root = g.recordGeneration({
      image: bytes('root'),
      label: 'root',
      location: 'images/root.png',
      prompt: 'p',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:10Z',
    })
    g.recordGeneration({
      image: bytes('edited'),
      label: 'edited',
      location: 'images/edited.png',
      prompt: 'edit',
      model: 'm',
      seed: 2,
      conditioningImageDigest: 'a'.repeat(64),
      conditioningImageLocation: 'images/aaaaaaaaaaaaaaaa.png',
      maskImageDigest: 'b'.repeat(64),
      maskImageLocation: 'images/bbbbbbbbbbbbbbbb.png',
      derivedFrom: [root.id],
      startedAtTime: '2026-08-20T10:01:00Z',
      endedAtTime: '2026-08-20T10:01:10Z',
    })

    expect(g.deleteSession(root.id).removedConditioningImages).toEqual([
      'images/aaaaaaaaaaaaaaaa.png',
    ])
  })

  it('消した会話のinpaintingマスクも対象として返る', () => {
    const g = new ProvGraph()
    const root = g.recordGeneration({
      image: bytes('root'),
      label: 'root',
      prompt: 'p',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:10Z',
    })
    g.recordGeneration({
      image: bytes('edited'),
      label: 'edited',
      prompt: 'edit',
      model: 'big-lama',
      seed: 0,
      maskImageDigest: 'b'.repeat(64),
      maskImageLocation: 'images/bbbbbbbbbbbbbbbb.png',
      derivedFrom: [root.id],
      startedAtTime: '2026-08-20T10:01:00Z',
      endedAtTime: '2026-08-20T10:01:10Z',
    })

    expect(g.deleteSession(root.id).removedMaskImages).toEqual([
      'images/bbbbbbbbbbbbbbbb.png',
    ])
  })

  it('JSON-LD を往復しても表示名が保たれる', () => {
    const { g, v1 } = graphWithTwoVersions()
    g.assertTitle({ root: v1.id, title: 'Asterism のロゴ', at: '2026-08-21T09:00:00Z' })
    const restored = fromProvJsonLd(toProvJsonLd(g), DEFAULT_BASE)
    expect(restored.toData()).toEqual(g.toData())
    expect(restored.titleOf(v1.id)).toBe('Asterism のロゴ')
  })

  it('グラフに無い版には表明できない', () => {
    const { g } = graphWithTwoVersions()
    expect(() =>
      g.assertReference({ about: 'https://example.org/x', referenced: [CURVE], at: 'now' }),
    ).toThrow(/その版がグラフに無い/)
  })
})

describe('出し直して食い違ったとき', () => {
  it('派生ではなく alternateOf で繋ぎ、同じ会話に留まる', () => {
    const g = new ProvGraph()
    const common = {
      prompt: 'p',
      model: 'm',
      seed: 1,
      startedAtTime: '2026-08-20T10:00:00Z',
      endedAtTime: '2026-08-20T10:00:10Z',
    }
    const first = g.recordGeneration({ ...common, image: bytes('a'), label: '初回' })
    const again = g.recordGeneration({
      ...common,
      image: bytes('b'),
      label: '再実行（食い違い）',
      startedAtTime: '2026-08-20T11:00:00Z',
      endedAtTime: '2026-08-20T11:00:10Z',
      alternateOf: first.id,
    })

    // 会話は 1 つのまま
    expect(g.roots()).toHaveLength(1)
    expect(g.rootOf(again.id)).toBe(first.id)
    // 派生の辺は張らない（前の絵を材料にしたわけではない）
    expect(g.activityThatGenerated(again.id)!.used).toEqual([])
    expect(toNTriples(g).some((l) => l.includes('#alternateOf'))).toBe(true)
  })
})
