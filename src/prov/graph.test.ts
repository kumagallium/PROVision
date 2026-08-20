import { describe, expect, it } from 'vitest'
import { ProvGraph, ReproducibilityError } from './graph.js'
import type { RecordGenerationInput } from './graph.js'

const bytes = (s: string) => new TextEncoder().encode(s)

function base(overrides: Partial<RecordGenerationInput> = {}): RecordGenerationInput {
  return {
    image: bytes('gen-1'),
    label: '第 1 案',
    prompt: 'a minimal concept diagram of a thermoelectric module',
    model: 'z-image-turbo-4bit',
    seed: 42,
    startedAtTime: '2026-08-20T10:00:00Z',
    endedAtTime: '2026-08-20T10:00:12Z',
    ...overrides,
  }
}

describe('ProvGraph', () => {
  it('画像 1 枚につき Entity と Activity を 1 つずつ作る', () => {
    const g = new ProvGraph()
    const e = g.recordGeneration(base())

    expect(g.listEntities()).toHaveLength(1)
    expect(g.listActivities()).toHaveLength(1)
    expect(e.id).toContain('/image/')
    expect(e.digest).toHaveLength(64)
  })

  it('内容ハッシュが同じなら同じ Entity に収束する', () => {
    const g = new ProvGraph()
    const a = g.recordGeneration(base())
    const b = g.recordGeneration(base({ startedAtTime: '2026-08-20T11:00:00Z' }))

    expect(b.id).toBe(a.id)
    expect(g.listEntities()).toHaveLength(1)
    // 別々の生成なので Activity は 2 つ
    expect(g.listActivities()).toHaveLength(2)
  })

  it('再実行に要る情報が欠けていたら記録を拒否する', () => {
    const g = new ProvGraph()
    expect(() => g.recordGeneration(base({ prompt: '  ' }))).toThrow(ReproducibilityError)
    expect(() => g.recordGeneration(base({ model: '' }))).toThrow(ReproducibilityError)
    expect(() =>
      g.recordGeneration(base({ seed: undefined as unknown as number })),
    ).toThrow(ReproducibilityError)
    expect(g.listActivities()).toHaveLength(0)
  })

  it('派生元がグラフに無ければ辺を張らない', () => {
    const g = new ProvGraph()
    expect(() =>
      g.recordGeneration(base({ derivedFrom: ['https://example.org/missing'] })),
    ).toThrow(/派生元の Entity がグラフに無い/)
  })

  it('3 世代の派生を辿れる', () => {
    const g = new ProvGraph()
    const agent = g.addAgent('mflux', 'mflux (z-image-turbo-4bit)')

    const g1 = g.recordGeneration(base({ agents: [agent.id] }))
    const g2 = g.recordGeneration(
      base({
        image: bytes('gen-2'),
        label: '余白を広げた案',
        intent: 'もっと余白を取って',
        seed: 43,
        derivedFrom: [g1.id],
        agents: [agent.id],
      }),
    )
    const g3 = g.recordGeneration(
      base({
        image: bytes('gen-3'),
        label: '寒色にした案',
        intent: '配色を寒色に寄せて',
        seed: 44,
        derivedFrom: [g2.id],
        agents: [agent.id],
      }),
    )

    const chain = g.lineage(g3.id)
    expect(chain).toHaveLength(3)
    expect(chain.map((a) => a.intent)).toEqual([
      undefined,
      'もっと余白を取って',
      '配色を寒色に寄せて',
    ])
    expect(g.children(g1.id).map((e) => e.id)).toEqual([g2.id])
  })

  it('枝分かれを表現できる', () => {
    const g = new ProvGraph()
    const root = g.recordGeneration(base())
    const left = g.recordGeneration(
      base({ image: bytes('left'), seed: 1, derivedFrom: [root.id], intent: '左案' }),
    )
    const right = g.recordGeneration(
      base({ image: bytes('right'), seed: 2, derivedFrom: [root.id], intent: '右案' }),
    )

    const children = g.children(root.id).map((e) => e.id).sort()
    expect(children).toEqual([left.id, right.id].sort())
  })
})
