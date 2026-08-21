/**
 * 派生グラフの組み立てと参照。
 *
 * 不変条件（引き継ぎ書 §7）:
 *   - 既存 Entity の中身は書き換えない。派生は必ず新しい Entity を作る
 *   - 再実行に要る情報が欠けた記録は受け付けない
 */
import type {
  AssertionActivity,
  GenerationActivity,
  ImageEntity,
  Iri,
  ProvAgent,
  ProvGraphData,
  PublishedFigure,
} from './types.js'
import {
  DEFAULT_BASE,
  activityIri,
  agentIri,
  assertionIri,
  figureIri,
  imageIri,
  sha256,
} from './iri.js'

export class ReproducibilityError extends Error {
  constructor(missing: string[]) {
    super(`再実行に要る情報が欠けている: ${missing.join(', ')}`)
    this.name = 'ReproducibilityError'
  }
}

export class ImmutabilityError extends Error {
  constructor(id: Iri) {
    super(`既存 Entity を別の内容で上書きしようとした: ${id}`)
    this.name = 'ImmutabilityError'
  }
}

/** 1 回の生成を記録するための入力。IRI は呼び出し側が知らなくてよい。 */
export interface RecordGenerationInput {
  /**
   * 画像の**内容**のハッシュ、またはバイト列。
   *
   * PNG を扱うなら `imageContentDigest()` で取った値を渡すこと。
   * バイト列をそのまま渡すとファイル全体を数えるので、mflux が書く
   * 生成時刻のメタデータで、同じ絵でも毎回別の Entity になる（実測で踏んだ）。
   */
  image: Uint8Array | { digest: string }
  label: string
  mediaType?: string
  location?: string

  prompt: string
  model: string
  seed: number
  startedAtTime: string
  endedAtTime: string

  intent?: string
  negativePrompt?: string
  imageStrength?: number
  conditioningImageDigest?: string
  conditioningImageLocation?: string
  maskImageDigest?: string
  maskImageLocation?: string
  provider?: string
  steps?: number
  guidance?: number
  width?: number
  height?: number

  /** 派生元の画像 Entity の IRI。空なら根 */
  derivedFrom?: Iri[]
  /** 同じ指定で出し直して食い違ったときの相手（prov:alternateOf） */
  alternateOf?: Iri
  /** 人間が参照した外部リソースの IRI（asterism の curve / sample など） */
  referenced?: Iri[]
  agents?: Iri[]
}

export class ProvGraph {
  readonly base: string
  private readonly entities = new Map<Iri, ImageEntity>()
  private readonly activities = new Map<Iri, GenerationActivity>()
  private readonly assertions = new Map<Iri, AssertionActivity>()
  private readonly agents = new Map<Iri, ProvAgent>()

  constructor(base: string = DEFAULT_BASE) {
    this.base = base
  }

  static from(data: ProvGraphData): ProvGraph {
    const g = new ProvGraph(data.base)
    for (const a of data.agents) g.agents.set(a.id, a)
    for (const e of data.entities) g.entities.set(e.id, e)
    for (const act of data.activities) g.activities.set(act.id, act)
    for (const a of data.assertions ?? []) g.assertions.set(a.id, a)
    return g
  }

  toData(): ProvGraphData {
    return {
      base: this.base,
      agents: [...this.agents.values()],
      entities: [...this.entities.values()],
      activities: [...this.activities.values()],
      assertions: [...this.assertions.values()],
    }
  }

  addAgent(slug: string, label: string, kind: ProvAgent['kind'] = 'SoftwareAgent'): ProvAgent {
    const id = agentIri(this.base, slug)
    const existing = this.agents.get(id)
    if (existing) return existing
    const agent: ProvAgent = { id, label, kind }
    this.agents.set(id, agent)
    return agent
  }

  listAgents(): ProvAgent[] {
    return [...this.agents.values()]
  }

  getEntity(id: Iri): ImageEntity | undefined {
    return this.entities.get(id)
  }

  getActivity(id: Iri): GenerationActivity | undefined {
    return this.activities.get(id)
  }

  listEntities(): ImageEntity[] {
    return [...this.entities.values()]
  }

  listActivities(): GenerationActivity[] {
    return [...this.activities.values()]
  }

  /** その Entity を生んだ Activity（画像 1 枚は 1 つの Activity から生まれる） */
  activityThatGenerated(entity: Iri): GenerationActivity | undefined {
    return this.listActivities().find((a) => a.generated === entity)
  }

  /**
   * 生成を 1 件記録する。Entity と Activity を作り、派生元があれば辺を張る。
   * 返り値は生成された画像の Entity。
   */
  recordGeneration(input: RecordGenerationInput): ImageEntity {
    const missing: string[] = []
    if (!input.prompt?.trim()) missing.push('prompt')
    if (!input.model?.trim()) missing.push('model')
    if (!Number.isInteger(input.seed)) missing.push('seed')
    if (!input.startedAtTime) missing.push('startedAtTime')
    if (!input.endedAtTime) missing.push('endedAtTime')
    if (missing.length > 0) throw new ReproducibilityError(missing)

    for (const src of input.derivedFrom ?? []) {
      if (!this.entities.has(src)) {
        throw new Error(`派生元の Entity がグラフに無い: ${src}`)
      }
    }

    const digest = 'digest' in input.image ? input.image.digest : sha256(input.image)
    const entityId = imageIri(this.base, digest)

    const entity: ImageEntity = {
      id: entityId,
      label: input.label,
      digest,
      mediaType: input.mediaType ?? 'image/png',
      ...(input.location ? { location: input.location } : {}),
      ...(input.alternateOf ? { alternateOf: input.alternateOf } : {}),
    }

    const existing = this.entities.get(entityId)
    if (existing) {
      // 同じ内容ハッシュなら同じ画像。中身が食い違うなら来歴が壊れている
      if (existing.digest !== entity.digest) throw new ImmutabilityError(entityId)
    } else {
      this.entities.set(entityId, entity)
    }

    const used = [...(input.derivedFrom ?? [])].sort()
    const key = [
      input.prompt,
      input.model,
      String(input.seed),
      input.startedAtTime,
      used.join('|'),
    ].join(' ')
    const actId = activityIri(this.base, key)

    const activity: GenerationActivity = {
      id: actId,
      label: input.intent?.trim() ? input.intent : input.label,
      prompt: input.prompt,
      model: input.model,
      seed: input.seed,
      startedAtTime: input.startedAtTime,
      endedAtTime: input.endedAtTime,
      ...(input.intent ? { intent: input.intent } : {}),
      ...(input.negativePrompt ? { negativePrompt: input.negativePrompt } : {}),
      ...(input.imageStrength !== undefined ? { imageStrength: input.imageStrength } : {}),
      ...(input.conditioningImageDigest
        ? { conditioningImageDigest: input.conditioningImageDigest }
        : {}),
      ...(input.conditioningImageLocation
        ? { conditioningImageLocation: input.conditioningImageLocation }
        : {}),
      ...(input.maskImageDigest ? { maskImageDigest: input.maskImageDigest } : {}),
      ...(input.maskImageLocation ? { maskImageLocation: input.maskImageLocation } : {}),
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
      ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      used,
      referenced: [...(input.referenced ?? [])].sort(),
      generated: entityId,
      wasAssociatedWith: [...(input.agents ?? [])].sort(),
    }
    this.activities.set(actId, activity)

    return this.entities.get(entityId)!
  }

  /** その画像に至るまでの Activity を、根に近い順に並べて返す */
  lineage(entity: Iri): GenerationActivity[] {
    const chain: GenerationActivity[] = []
    const seen = new Set<Iri>()
    const walk = (id: Iri) => {
      if (seen.has(id)) return
      seen.add(id)
      const act = this.activityThatGenerated(id)
      if (!act) return
      for (const src of act.used) walk(src)
      chain.push(act)
    }
    walk(entity)
    return chain
  }

  /**
   * 会話の根。親を持たない生成が生んだ画像。
   *
   * 会話（セッション）は別の語彙で表さない。**根ごとの連結成分がそのまま 1 つの会話**で、
   * グラフから導ける。別に持つと、グラフと食い違ったときにどちらが本当か分からなくなる。
   */
  roots(): ImageEntity[] {
    return this.listActivities()
      .filter((a) => a.used.length === 0)
      .map((a) => this.entities.get(a.generated))
      .filter((e): e is ImageEntity => e !== undefined)
      // 出し直して食い違った版は、元の版と同じ会話に属する。会話の根ではない
      .filter((e) => !(e.alternateOf && this.entities.has(e.alternateOf)))
  }

  /** その画像が属する会話の根 */
  rootOf(entity: Iri): Iri | undefined {
    let current: Iri | undefined = entity
    const seen = new Set<Iri>()
    while (current && !seen.has(current)) {
      seen.add(current)
      const act = this.activityThatGenerated(current)
      if (!act) return this.entities.has(current) ? current : undefined
      if (act.used.length === 0) {
        // 出し直して食い違った版は、元の版と同じ会話に属する
        const alternate: Iri | undefined = this.entities.get(current)?.alternateOf
        if (alternate && this.entities.has(alternate)) {
          current = alternate
          continue
        }
        return current
      }
      current = act.used[0]
    }
    return undefined
  }

  /** その会話に属する画像を、生まれた順に返す */
  session(root: Iri): ImageEntity[] {
    return this.listEntities()
      .filter((e) => this.rootOf(e.id) === root)
      .sort((a, b) => {
        const ta = this.activityThatGenerated(a.id)?.startedAtTime ?? ''
        const tb = this.activityThatGenerated(b.id)?.startedAtTime ?? ''
        return ta.localeCompare(tb)
      })
  }

  listAssertions(): AssertionActivity[] {
    return [...this.assertions.values()]
  }

  /**
   * 「この版はこのデータに基づく」と後から表明する。
   *
   * 生成時の記録は書き換えない。**いつ・誰が言ったか**ごと別の Activity に残す（D-008）。
   * 画像生成モデルがデータを読んだわけではないので、ここでも `wasDerivedFrom` は張らない。
   */
  assertReference(input: {
    about: Iri
    referenced: Iri[]
    at: string
    agents?: Iri[]
  }): AssertionActivity {
    if (!this.entities.has(input.about)) {
      throw new Error(`その版がグラフに無い: ${input.about}`)
    }
    const referenced = [...new Set(input.referenced.map((r) => r.trim()).filter(Boolean))].sort()
    if (referenced.length === 0) throw new Error('参照する IRI がありません')

    const id = assertionIri(this.base, `reference ${input.about} ${referenced.join('|')}`)
    const assertion: AssertionActivity = {
      id,
      kind: 'reference',
      label: `参照の表明（${referenced.length} 件）`,
      about: input.about,
      referenced,
      startedAtTime: input.at,
      wasAssociatedWith: [...(input.agents ?? [])].sort(),
    }
    this.assertions.set(id, assertion)
    return assertion
  }

  /** 「この版が、この論文の Figure N として載った」と表明する */
  assertPublication(input: {
    about: Iri
    /** 掲載時の呼び名。"Figure 2" など */
    figureLabel: string
    /** 載った先。DOI や URL */
    partOf: Iri
    at: string
    agents?: Iri[]
  }): AssertionActivity {
    if (!this.entities.has(input.about)) {
      throw new Error(`その版がグラフに無い: ${input.about}`)
    }
    const partOf = input.partOf.trim()
    const label = input.figureLabel.trim()
    if (!partOf || !label) throw new Error('掲載先と図版の呼び名が要ります')

    const figure: PublishedFigure = { id: figureIri(partOf, label), label, partOf }
    const id = assertionIri(this.base, `publication ${input.about} ${figure.id}`)
    const assertion: AssertionActivity = {
      id,
      kind: 'publication',
      label: `掲載の表明（${label}）`,
      about: input.about,
      referenced: [],
      figure,
      startedAtTime: input.at,
      wasAssociatedWith: [...(input.agents ?? [])].sort(),
    }
    this.assertions.set(id, assertion)
    return assertion
  }

  /**
   * 会話に表示名を付ける。
   *
   * **最初の指示は書き換えない。** 「何と打って始めたか」は生成の記録として残し、
   * 「こう呼ぶことにした」は別の表明として足す（D-008）。付け直した履歴も残る。
   */
  assertTitle(input: {
    root: Iri
    title: string
    at: string
    agents?: Iri[]
  }): AssertionActivity {
    if (!this.entities.has(input.root)) {
      throw new Error(`その会話がグラフに無い: ${input.root}`)
    }
    const title = input.title.trim()
    if (!title) throw new Error('表示名が空です')

    const id = assertionIri(this.base, `title ${input.root} ${title} ${input.at}`)
    const assertion: AssertionActivity = {
      id,
      kind: 'title',
      label: `表示名の変更（${title}）`,
      about: input.root,
      referenced: [],
      title,
      startedAtTime: input.at,
      wasAssociatedWith: [...(input.agents ?? [])].sort(),
    }
    this.assertions.set(id, assertion)
    return assertion
  }

  /** 会話の表示名。付けていなければ undefined（呼び側が最初の指示に落とす） */
  titleOf(root: Iri): string | undefined {
    const latest = this.listAssertions()
      .filter((a) => a.kind === 'title' && a.about === root && a.title)
      .sort((a, b) => a.startedAtTime.localeCompare(b.startedAtTime))
      .pop()
    return latest?.title
  }

  /**
   * 会話をまるごと消す。**これは記録の書き換えではなく、記録そのものの破棄。**
   * 消したことは残らない——残す意味があるなら消してはいけない、という立場を取る。
   *
   * 返り値は、もうどこからも参照されなくなった画像と編集用入力画像の置き場所。
   * ファイルの削除は呼び側（サーバ）がやる。
   */
  deleteSession(root: Iri): {
    removedImages: string[]
    removedConditioningImages: string[]
    removedMaskImages: string[]
  } {
    const doomed = new Set(this.session(root).map((e) => e.id))
    if (doomed.size === 0) throw new Error(`その会話がグラフに無い: ${root}`)

    const removedImages: string[] = []
    const conditioningImages = new Set<string>()
    const maskImages = new Set<string>()
    for (const activity of this.listActivities()) {
      if (doomed.has(activity.generated) && activity.conditioningImageLocation) {
        conditioningImages.add(activity.conditioningImageLocation)
      }
      if (doomed.has(activity.generated) && activity.maskImageLocation) {
        maskImages.add(activity.maskImageLocation)
      }
    }
    for (const id of doomed) {
      const location = this.entities.get(id)?.location
      if (location) removedImages.push(location)
      this.entities.delete(id)
    }
    for (const [id, act] of [...this.activities]) {
      if (doomed.has(act.generated)) this.activities.delete(id)
    }
    for (const [id, a] of [...this.assertions]) {
      if (doomed.has(a.about)) this.assertions.delete(id)
    }
    const remainingConditioningImages = new Set(
      this.listActivities()
        .map((activity) => activity.conditioningImageLocation)
        .filter((location): location is string => location !== undefined),
    )
    const remainingMaskImages = new Set(
      this.listActivities()
        .map((activity) => activity.maskImageLocation)
        .filter((location): location is string => location !== undefined),
    )
    return {
      removedImages,
      removedConditioningImages: [...conditioningImages].filter(
        (location) => !remainingConditioningImages.has(location),
      ),
      removedMaskImages: [...maskImages].filter(
        (location) => !remainingMaskImages.has(location),
      ),
    }
  }

  /**
   * その版が基づく外部データ。系譜をさかのぼって集める。
   * 生成時に指定したものと、後から表明したものの両方。
   */
  referencesOf(entity: Iri): Iri[] {
    const chain = this.lineage(entity)
    const fromGeneration = chain.flatMap((a) => a.referenced)
    const onPath = new Set(chain.map((a) => a.generated))
    onPath.add(entity)
    const fromAssertion = this.listAssertions()
      .filter((a) => a.kind === 'reference' && onPath.has(a.about))
      .flatMap((a) => a.referenced)
    return [...new Set([...fromGeneration, ...fromAssertion])].sort()
  }

  /** その版が載った figure。無ければ空 */
  publicationsOf(entity: Iri): PublishedFigure[] {
    return this.listAssertions()
      .filter((a) => a.kind === 'publication' && a.about === entity && a.figure)
      .map((a) => a.figure!)
  }

  /** その画像から直接派生した画像 */
  children(entity: Iri): ImageEntity[] {
    return this.listActivities()
      .filter((a) => a.used.includes(entity))
      .map((a) => this.entities.get(a.generated))
      .filter((e): e is ImageEntity => e !== undefined)
  }
}
