/**
 * PROVision のドメイン型。
 *
 * W3C PROV の Entity / Activity / Agent をそのまま素直に写す。
 * 画像生成に固有の語（model / seed / prompt など）だけ provision 名前空間に置く。
 * 詳細は docs/decisions.md の D-001〜D-004。
 */

export type Iri = string

/** 画像 1 枚 = 1 Entity（D-001）。同一性は内容ハッシュで決まる。 */
export interface ImageEntity {
  id: Iri
  label: string
  /** SHA-256（hex）。IRI の由来でもある */
  digest: string
  mediaType: string
  /** 画像の実体の場所。ファイルパスまたは URL */
  location?: string
}

/** 再実行に要る情報。1 つでも欠けたら記録を拒否する（D-002）。 */
export interface ReproducibleSpec {
  prompt: string
  model: string
  seed: number
  startedAtTime: string
  endedAtTime: string
}

/** 1 回の生成 = 1 Activity。 */
export interface GenerationActivity extends ReproducibleSpec {
  id: Iri
  label: string
  /** 利用者が出した自然言語の指示。辺ではなく Activity に置く（D-003） */
  intent?: string
  negativePrompt?: string
  provider?: string
  steps?: number
  guidance?: number
  width?: number
  height?: number
  /** 派生元の画像。空なら根（初回生成） */
  used: Iri[]
  /** この Activity が生んだ画像 */
  generated: Iri
  wasAssociatedWith: Iri[]
}

export type AgentKind = 'SoftwareAgent' | 'Person' | 'Organization'

export interface ProvAgent {
  id: Iri
  label: string
  kind: AgentKind
}

export interface ProvGraphData {
  /** IRI の基底。既定は DEFAULT_BASE */
  base: string
  entities: ImageEntity[]
  activities: GenerationActivity[]
  agents: ProvAgent[]
}
