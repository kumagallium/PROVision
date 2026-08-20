/**
 * 派生グラフの組み立てと参照。
 *
 * 不変条件（引き継ぎ書 §7）:
 *   - 既存 Entity の中身は書き換えない。派生は必ず新しい Entity を作る
 *   - 再実行に要る情報が欠けた記録は受け付けない
 */
import type {
  GenerationActivity,
  ImageEntity,
  Iri,
  ProvAgent,
  ProvGraphData,
} from './types.js'
import { DEFAULT_BASE, activityIri, agentIri, imageIri, sha256 } from './iri.js'

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
  /** 生成された画像のバイト列、または既に取った SHA-256（hex） */
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
  provider?: string
  steps?: number
  guidance?: number
  width?: number
  height?: number

  /** 派生元の画像 Entity の IRI。空なら根 */
  derivedFrom?: Iri[]
  agents?: Iri[]
}

export class ProvGraph {
  readonly base: string
  private readonly entities = new Map<Iri, ImageEntity>()
  private readonly activities = new Map<Iri, GenerationActivity>()
  private readonly agents = new Map<Iri, ProvAgent>()

  constructor(base: string = DEFAULT_BASE) {
    this.base = base
  }

  static from(data: ProvGraphData): ProvGraph {
    const g = new ProvGraph(data.base)
    for (const a of data.agents) g.agents.set(a.id, a)
    for (const e of data.entities) g.entities.set(e.id, e)
    for (const act of data.activities) g.activities.set(act.id, act)
    return g
  }

  toData(): ProvGraphData {
    return {
      base: this.base,
      agents: [...this.agents.values()],
      entities: [...this.entities.values()],
      activities: [...this.activities.values()],
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
      ...(input.provider ? { provider: input.provider } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
      ...(input.guidance !== undefined ? { guidance: input.guidance } : {}),
      ...(input.width !== undefined ? { width: input.width } : {}),
      ...(input.height !== undefined ? { height: input.height } : {}),
      used,
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

  /** その画像から直接派生した画像 */
  children(entity: Iri): ImageEntity[] {
    return this.listActivities()
      .filter((a) => a.used.includes(entity))
      .map((a) => this.entities.get(a.generated))
      .filter((e): e is ImageEntity => e !== undefined)
  }
}
