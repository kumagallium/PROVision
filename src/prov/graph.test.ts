import { describe, expect, it } from 'vitest'
import { ProvGraph, ReproducibilityError, UnchangedImageError } from './graph.js'
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
  it('作り直しを繰り返しても、戻る先は最初の元絵のまま', () => {
    const g = new ProvGraph()
    const art = g.recordGeneration(base({ location: 'images/art.png' }))
    // 1回目: 元絵へ帯を足す
    const first = g.recordGeneration(
      base({
        image: bytes('band-24'),
        prompt: '「asterism」というロゴタイプを付けて',
        model: 'jimp-1.6.1',
        seed: 0,
        derivedFrom: [art.id],
        location: 'images/band24.png',
        selectedTool: 'image.wordmark',
        toolArguments: JSON.stringify({ text: 'asterism', padding: 24 }),
        startedAtTime: '2026-08-20T11:00:00Z',
        endedAtTime: '2026-08-20T11:00:01Z',
      }),
    )
    expect(g.rebuildBaseOf(first.id, 'image.wordmark')?.digest).toBe(art.digest)

    // 2回目: 帯を狭めて作り直す。使ったのは元絵なので、そう記録される
    const second = g.recordGeneration(
      base({
        image: bytes('band-8'),
        prompt: 'もう少し縮めてください',
        model: 'jimp-1.6.1',
        seed: 0,
        derivedFrom: [first.id],
        location: 'images/band8.png',
        selectedTool: 'image.wordmark',
        toolArguments: JSON.stringify({ text: 'asterism', padding: 8 }),
        conditioningImageDigest: art.digest,
        conditioningImageLocation: 'images/art.png',
        startedAtTime: '2026-08-20T12:00:00Z',
        endedAtTime: '2026-08-20T12:00:01Z',
      }),
    )
    // 3回目の戻り先も元絵。画面上の親（帯付き）へ戻ると帯が重なる
    expect(g.rebuildBaseOf(second.id, 'image.wordmark')?.digest).toBe(art.digest)
    // 別のツールで作られた版には効かせない
    expect(g.rebuildBaseOf(second.id, 'image.trim')).toBeUndefined()
  })

  it('違う指示が同じ絵に行き着いたら、両方の Activity を繋ぐ', () => {
    const g = new ProvGraph()
    const parent = g.recordGeneration(base())
    // 確定的なツールでは、言い方が違っても同じ画素になる（D-001で同じEntity）
    const common = {
      image: bytes('wordmark-out'),
      model: 'jimp-1.6.1',
      seed: 0,
      derivedFrom: [parent.id],
    }
    const first = g.recordGeneration(
      base({ ...common, prompt: '「asterism」というロゴタイプを付けて' }),
    )
    const second = g.recordGeneration(
      base({
        ...common,
        prompt: 'ロゴタイプを付けて',
        startedAtTime: '2026-08-20T12:00:00Z',
        endedAtTime: '2026-08-20T12:00:01Z',
      }),
    )
    expect(second.id).toBe(first.id)
    // 片方だけ繋ぐと、もう片方が出力の無いActivityとして宙に浮く
    expect(g.activitiesThatGenerated(first.id)).toHaveLength(2)
  })

  it('派生元と同じ画像は記録せず、自己ループを作らない', () => {
    const g = new ProvGraph()
    const parent = g.recordGeneration(base())
    // 同じ画素をもう一度渡す＝内容ハッシュが同じ＝同じEntity（D-001）
    expect(() =>
      g.recordGeneration(
        base({
          image: bytes('gen-1'),
          intent: '余白を整えて',
          derivedFrom: [parent.id],
          startedAtTime: '2026-08-20T11:00:00Z',
          endedAtTime: '2026-08-20T11:00:03Z',
        }),
      ),
    ).toThrow(UnchangedImageError)
    // 失敗した記録がグラフへ残らない
    expect(g.listActivities()).toHaveLength(1)
    expect(g.listEntities()).toHaveLength(1)
  })

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

describe('1 回の送信を節点として置く（D-022）', () => {
  /** 親が無いまま候補を 3 つ出した状態 */
  function threeCandidates() {
    const g = new ProvGraph()
    const plan = g.addPlan('星座のロゴを作って', '2026-08-26T10:00:00Z')
    const made = ['a', 'b', 'c'].map((tag, i) =>
      g.recordGeneration(
        base({
          image: bytes(`candidate-${tag}`),
          label: `候補 ${tag}`,
          intent: '星座のロゴを作って',
          seed: 100 + i,
          planId: plan.id,
          startedAtTime: `2026-08-26T10:00:0${i}Z`,
          endedAtTime: `2026-08-26T10:01:0${i}Z`,
        }),
      ),
    )
    return { g, plan, made }
  }

  it('親が無い候補でも、会話は 1 つになる', () => {
    const { g, made } = threeCandidates()
    // ここが D-022 の目的。指示を置かないと根が 3 つ＝会話が 3 つ生まれる
    expect(g.roots()).toHaveLength(1)
    expect(g.roots()[0]?.id).toBe(made[0]!.id)
    for (const entity of made) expect(g.rootOf(entity.id)).toBe(made[0]!.id)
    expect(g.session(made[0]!.id).map((e) => e.id).sort()).toEqual(
      made.map((e) => e.id).sort(),
    )
  })

  it('その送信から走った Activity を引ける', () => {
    const { g, plan } = threeCandidates()
    expect(g.activitiesOfPlan(plan.id)).toHaveLength(3)
    // 生まれた順。画面で候補を並べる順でもある
    expect(g.activitiesOfPlan(plan.id).map((a) => a.seed)).toEqual([100, 101, 102])
  })

  it('同じ指示・同じ時刻なら同じ Plan に収束する', () => {
    const g = new ProvGraph()
    const first = g.addPlan('同じ指示', '2026-08-26T10:00:00Z')
    const again = g.addPlan('同じ指示', '2026-08-26T10:00:00Z')
    expect(again.id).toBe(first.id)
    expect(g.listPlans()).toHaveLength(1)
    // 時刻が違えば別の送信
    expect(g.addPlan('同じ指示', '2026-08-26T11:00:00Z').id).not.toBe(first.id)
  })

  it('送信を置かない版は、これまでどおり 1 版 1 会話', () => {
    const g = new ProvGraph()
    const one = g.recordGeneration(base({ image: bytes('single-1') }))
    const two = g.recordGeneration(base({ image: bytes('single-2'), seed: 9 }))
    expect(g.roots().map((e) => e.id).sort()).toEqual([one.id, two.id].sort())
  })
})
