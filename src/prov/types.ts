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
  /**
   * 同じ指定で出し直したら別の絵になった、というときの相手（`prov:alternateOf`）。
   *
   * 派生ではない——前の絵を材料にしたわけではないので `wasDerivedFrom` は嘘になる。
   * PROV に「同じものを指す別の実体」を表す語があるので、それを使う。
   */
  alternateOf?: Iri
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
  /** image-to-image で親画像をどれだけ残したか */
  imageStrength?: number
  provider?: string
  steps?: number
  guidance?: number
  width?: number
  height?: number
  /** 派生元の画像。空なら根（初回生成） */
  used: Iri[]
  /**
   * 図版を作るときに人間が参照した外部リソースの IRI
   * （asterism の測定曲線・試料など）。
   *
   * 機械が消費したわけではないので `wasDerivedFrom` は張らない。
   * 「著者がこれを見てこの図を作らせた」という実在する事実だけを
   * `prov:used` として書く。責任者は wasAssociatedWith の人間 Agent。
   */
  referenced: Iri[]
  /** この Activity が生んだ画像 */
  generated: Iri
  wasAssociatedWith: Iri[]
}

/**
 * 人が、既存の版について**後から表明したこと**。絵は作らない。
 *
 * 既存の Entity や Activity を書き換えずに済ませるための形（D-008）。
 * 「生成時に分かっていた事実」と「後から人が主張したこと」を混ぜないために、
 * 別の Activity として、いつ・誰が言ったのかごと記録する。
 */
export interface AssertionActivity {
  id: Iri
  /**
   * reference: このデータに基づく
   * publication: この figure として載った
   * title: この会話をこう呼ぶことにした
   */
  kind: 'reference' | 'publication' | 'title'
  label: string
  /** 何についての表明か。画像 Entity の IRI */
  about: Iri
  /** kind === 'reference' のとき。参照した外部リソース */
  referenced: Iri[]
  /** kind === 'publication' のとき。載った先 */
  figure?: PublishedFigure
  /** kind === 'title' のとき。会話の表示名 */
  title?: string
  startedAtTime: string
  wasAssociatedWith: Iri[]
}

/** 論文などに載った図版。fabio:Figure として書き出す */
export interface PublishedFigure {
  id: Iri
  /** 掲載時の呼び名。"Figure 2" など */
  label: string
  /** 載った先。DOI や URL */
  partOf: Iri
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
  /** 後から人が表明したこと。古いファイルには無いので省略可 */
  assertions?: AssertionActivity[]
  agents: ProvAgent[]
}
