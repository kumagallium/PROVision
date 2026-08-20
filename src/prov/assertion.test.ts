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

  it('グラフに無い版には表明できない', () => {
    const { g } = graphWithTwoVersions()
    expect(() =>
      g.assertReference({ about: 'https://example.org/x', referenced: [CURVE], at: 'now' }),
    ).toThrow(/その版がグラフに無い/)
  })
})
