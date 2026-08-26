/**
 * PROV-JSONLD の読み書き。
 *
 * 形は openprovenance の PROV-JSONLD に合わせる（D-005）。
 * 関係は実体ノード（Usage / Generation / Association）として書き、
 * 併せて Entity / Activity 側に素の PROV プロパティ
 * （wasDerivedFrom / wasGeneratedBy / used / wasAssociatedWith）も持たせる。
 * 前者は prov-jsonld-viz が辺を描くため、後者は SPARQL が素直に書けるため。
 */
import type {
  AssertionActivity,
  GenerationActivity,
  ImageEntity,
  InstructionPlan,
  ProvAgent,
  ProvGraphData,
} from './types.js'
import { ProvGraph } from './graph.js'

/**
 * 拡張語彙の @context。**GitHub Pages で実際に配信している**（`docs/schema/`）。
 * 実在しない URL を書いておくと、JSON-LD を素直に展開する側が 404 を踏む。
 */
export const PROVISION_CONTEXT_URL =
  'https://kumagallium.github.io/PROVision/schema/context.jsonld'

export const PROV_JSONLD_CONTEXT_URL =
  'https://openprovenance.org/prov-jsonld/context.jsonld'

export const PROV_CONTEXT = [
  { '@vocab': 'http://www.w3.org/ns/prov#' },
  PROV_JSONLD_CONTEXT_URL,
  PROVISION_CONTEXT_URL,
] as const

type JsonValue = string | number | boolean | null | JsonValue[] | { [k: string]: JsonValue }
export type JsonLdNode = { [k: string]: JsonValue }

export interface ProvJsonLdDocument {
  '@context': JsonValue
  '@graph': JsonLdNode[]
}

const XSD = 'http://www.w3.org/2001/XMLSchema#'

function lit(value: string | number, type?: string): JsonLdNode[] {
  return [type ? { '@value': value, '@type': type } : { '@value': value }]
}

function refs(iris: readonly string[]): JsonLdNode[] {
  return iris.map((id) => ({ '@id': id }))
}

/** 配列で来るかもしれない JSON-LD の値から素の値を 1 つ取り出す */
function firstValue(node: JsonLdNode, key: string): string | number | undefined {
  const raw = node[key]
  if (raw === undefined || raw === null) return undefined
  const item = Array.isArray(raw) ? raw[0] : raw
  if (item === null || item === undefined) return undefined
  if (typeof item === 'object' && '@value' in item) {
    const v = (item as { '@value': JsonValue })['@value']
    return typeof v === 'string' || typeof v === 'number' ? v : undefined
  }
  return typeof item === 'string' || typeof item === 'number' ? item : undefined
}

function idList(node: JsonLdNode, key: string): string[] {
  const raw = node[key]
  if (raw === undefined || raw === null) return []
  const items = Array.isArray(raw) ? raw : [raw]
  return items
    .map((item) => {
      if (typeof item === 'string') return item
      if (item && typeof item === 'object' && '@id' in item) {
        const v = (item as { '@id': JsonValue })['@id']
        return typeof v === 'string' ? v : undefined
      }
      return undefined
    })
    .filter((v): v is string => v !== undefined)
}

function entityNode(e: ImageEntity, derivedFrom: string[], generatedBy: string[]): JsonLdNode {
  return {
    '@id': e.id,
    '@type': 'Entity',
    label: lit(e.label),
    'provision:imageDigest': lit(e.digest),
    'provision:mediaType': lit(e.mediaType),
    ...(e.location ? { atLocation: lit(e.location) } : {}),
    ...(e.alternateOf ? { alternateOf: refs([e.alternateOf]) } : {}),
    ...(derivedFrom.length > 0 ? { wasDerivedFrom: refs(derivedFrom) } : {}),
    ...(generatedBy.length > 0 ? { wasGeneratedBy: refs(generatedBy) } : {}),
  }
}

function activityNode(a: GenerationActivity): JsonLdNode {
  const optionalNumber = (key: string, value: number | undefined, type: string) =>
    value === undefined ? {} : { [key]: lit(value, type) }

  return {
    '@id': a.id,
    '@type': 'Activity',
    label: lit(a.label),
    startedAtTime: lit(a.startedAtTime, `${XSD}dateTime`),
    endedAtTime: lit(a.endedAtTime, `${XSD}dateTime`),
    'provision:prompt': lit(a.prompt),
    'provision:model': lit(a.model),
    'provision:seed': lit(a.seed, `${XSD}integer`),
    ...(a.intent ? { 'provision:intent': lit(a.intent) } : {}),
    ...(a.negativePrompt ? { 'provision:negativePrompt': lit(a.negativePrompt) } : {}),
    ...optionalNumber('provision:imageStrength', a.imageStrength, `${XSD}decimal`),
    ...(a.conditioningImageDigest
      ? { 'provision:conditioningImageDigest': lit(a.conditioningImageDigest) }
      : {}),
    ...(a.conditioningImageLocation
      ? { 'provision:conditioningImageLocation': lit(a.conditioningImageLocation) }
      : {}),
    ...(a.maskImageDigest ? { 'provision:maskImageDigest': lit(a.maskImageDigest) } : {}),
    ...(a.maskImageLocation
      ? { 'provision:maskImageLocation': lit(a.maskImageLocation) }
      : {}),
    ...(a.commandTemplate ? { 'provision:commandTemplate': lit(a.commandTemplate) } : {}),
    ...(a.reproducibility ? { 'provision:reproducibility': lit(a.reproducibility) } : {}),
    ...(a.pixelOrigin ? { 'provision:pixelOrigin': lit(a.pixelOrigin) } : {}),
    ...(a.planningMode ? { 'provision:planningMode': lit(a.planningMode) } : {}),
    ...(a.plannerProvider ? { 'provision:plannerProvider': lit(a.plannerProvider) } : {}),
    ...(a.plannerModel ? { 'provision:plannerModel': lit(a.plannerModel) } : {}),
    ...(a.selectedTool ? { 'provision:selectedTool': lit(a.selectedTool) } : {}),
    ...(a.toolArguments ? { 'provision:toolArguments': lit(a.toolArguments) } : {}),
    ...(a.sourceFileDigest ? { 'provision:sourceFileDigest': lit(a.sourceFileDigest) } : {}),
    ...(a.sourceFileMediaType
      ? { 'provision:sourceFileMediaType': lit(a.sourceFileMediaType) }
      : {}),
    ...(a.sourceFileName ? { 'provision:sourceFileName': lit(a.sourceFileName) } : {}),
    ...(a.provider ? { 'provision:provider': lit(a.provider) } : {}),
    ...optionalNumber('provision:steps', a.steps, `${XSD}integer`),
    ...optionalNumber('provision:guidance', a.guidance, `${XSD}decimal`),
    ...optionalNumber('provision:width', a.width, `${XSD}integer`),
    ...optionalNumber('provision:height', a.height, `${XSD}integer`),
    // 派生元の画像も、人間が参照した外部リソースも、PROV としては同じ prov:used。
    // 区別は Entity 側の wasDerivedFrom が持つ
    ...(a.used.length + a.referenced.length > 0
      ? { used: refs([...a.used, ...a.referenced]) }
      : {}),
    ...(a.wasAssociatedWith.length > 0
      ? { wasAssociatedWith: refs(a.wasAssociatedWith) }
      : {}),
  }
}

/** 読み戻しで受け付ける等級。知らない値は載せない（D-016） */
const REPRODUCIBILITY_VALUES = [
  'deterministic',
  'environment-dependent',
  'stochastic',
  'external',
]

/** 読み戻しで受け付ける画素の由来。知らない値は載せない（D-020） */
const PIXEL_ORIGIN_VALUES = [
  'geometric',
  'annotated',
  'photometric',
  'removed',
  'synthesized',
  'external',
]

function agentNode(agent: ProvAgent): JsonLdNode {
  return {
    '@id': agent.id,
    '@type': agent.kind === 'SoftwareAgent' ? 'SoftwareAgent' : agent.kind,
    label: lit(agent.label),
    ...(agent.role ? { 'provision:role': lit(agent.role) } : {}),
    // 実測できたものだけ載せる（D-015）。空の枠を書くと「調べたが無い」と
    // 「そもそも調べていない」が区別できなくなる
    ...(agent.version ? { 'provision:version': lit(agent.version) } : {}),
    ...(agent.modelFingerprint ? { 'provision:modelFingerprint': lit(agent.modelFingerprint) } : {}),
    ...(agent.platform ? { 'provision:platform': lit(agent.platform) } : {}),
  }
}

export function toProvJsonLd(graph: ProvGraph): ProvJsonLdDocument {
  const data = graph.toData()
  const nodes: JsonLdNode[] = []

  for (const agent of data.agents) nodes.push(agentNode(agent))

  for (const e of data.entities) {
    // 同じ絵に行き着いた Activity は全部繋ぐ。1 本だけだと残りが宙に浮く
    const acts = graph.activitiesThatGenerated(e.id)
    const derivedFrom = [...new Set(acts.flatMap((a) => a.used))]
    nodes.push(
      entityNode(
        e,
        derivedFrom,
        acts.map((a) => a.id),
      ),
    )
  }

  // 人間が参照した外部リソース（asterism の曲線など）にもノードを置く。
  // 無いと prov-jsonld-viz が「端点の無い辺」で例外を投げ、辺が 1 本も描かれない（実機で確認）。
  // 中身は主張しない——IRI と、asterism 側でも真である prov:Entity だけ
  const referenced = new Set(data.activities.flatMap((a) => a.referenced))
  for (const id of referenced) {
    nodes.push({
      '@id': id,
      '@type': 'Entity',
      label: lit(id.split('/').slice(-2).join('/')),
    })
  }

  // 1 回の送信（D-022）。prov:Plan は prov:Entity の下位なので新しい語彙は要らない
  for (const plan of data.plans ?? []) {
    nodes.push({
      '@id': plan.id,
      '@type': 'Plan',
      label: lit(plan.label),
      // Plan は Entity なので startedAtTime は使えない。生まれた時刻で言う
      generatedAtTime: lit(plan.startedAtTime, `${XSD}dateTime`),
    })
  }

  for (const a of data.activities) nodes.push(activityNode(a))


  // 後から人が表明したこと（D-008）。生成の Activity と同じ prov:Activity だが、
  // provision:prompt を持たないことで読み戻し時に区別できる
  for (const a of data.assertions ?? []) {
    nodes.push({
      '@id': a.id,
      '@type': 'Activity',
      label: lit(a.label),
      'provision:assertionAbout': refs([a.about]) as unknown as JsonValue,
      startedAtTime: lit(a.startedAtTime, `${XSD}dateTime`),
      used: refs([a.about, ...a.referenced]),
      ...(a.title ? { 'provision:title': lit(a.title) } : {}),
      ...(a.wasAssociatedWith.length > 0
        ? { wasAssociatedWith: refs(a.wasAssociatedWith) }
        : {}),
    })
    if (a.figure) {
      nodes.push({
        '@id': a.figure.id,
        '@type': ['Entity', 'fabio:Figure'] as unknown as JsonValue,
        label: lit(a.figure.label),
        'dcterms:identifier': lit(a.figure.label),
        'dcterms:isPartOf': refs([a.figure.partOf]),
        wasGeneratedBy: refs([a.id]),
        // 載った図版は、その版の画像から出てきたもの。ここは派生で正しい
        wasDerivedFrom: refs([a.about]),
      })
    }
  }

  // 関係は実体ノードとしても並べる（viz が辺を描くのはこちら）。
  // @id は付けない。付けると viz が関係そのものを孤立ノードとして描いてしまう
  for (const a of data.assertions ?? []) {
    for (const used of [a.about, ...a.referenced]) {
      nodes.push({ '@type': 'Usage', activity: a.id, entity: used })
    }
    if (a.figure) {
      nodes.push({ '@type': 'Generation', activity: a.id, entity: a.figure.id })
    }
  }

  for (const a of data.activities) {
    for (const used of [...a.used, ...a.referenced]) {
      nodes.push({ '@type': 'Usage', activity: a.id, entity: used })
    }
    nodes.push({ '@type': 'Generation', activity: a.id, entity: a.generated })
    for (const agent of a.wasAssociatedWith) {
      /**
       * どの送信から走ったか（D-022）は、この限定表現に載せる。`prov:hadPlan` は
       * Association の述語なので、素の PROV で言うにはここを通すしかない。
       * **載せる先は人間 Agent の Association だけ**——計画を持つのは責任者である（D-006）
       */
      const responsible =
        a.planId !== undefined &&
        data.agents.find((item) => item.id === agent)?.kind === 'Person'
      nodes.push({
        '@type': 'Association',
        activity: a.id,
        agent,
        ...(responsible ? { hadPlan: a.planId! } : {}),
      })
    }
  }

  return {
    '@context': PROV_CONTEXT as unknown as JsonValue,
    '@graph': nodes,
  }
}

/** 書き出した PROV-JSONLD を読み戻す。往復してグラフが一致すること。 */
export function fromProvJsonLd(doc: ProvJsonLdDocument, base: string): ProvGraph {
  const nodes = doc['@graph'] ?? []
  const typeOf = (n: JsonLdNode): string => {
    const t = n['@type']
    if (typeof t === 'string') return t
    if (Array.isArray(t) && typeof t[0] === 'string') return t[0]
    return ''
  }

  const entities: ImageEntity[] = []
  const agents: ProvAgent[] = []
  const activityNodes: JsonLdNode[] = []
  const plans: InstructionPlan[] = []
  /** Association から Activity へ引き直す。断片を落とせば元の Activity の IRI に戻る */
  const planByActivity = new Map<string, string>()
  /** 掲載された figure。どの表明が生んだかで引けるようにしておく */
  const figureByActivity = new Map<string, { id: string; label: string; partOf: string }>()

  for (const n of nodes) {
    const t = typeOf(n)
    const id = typeof n['@id'] === 'string' ? (n['@id'] as string) : ''
    if (!id) continue

    if (t === 'Entity') {
      const types = Array.isArray(n['@type']) ? (n['@type'] as unknown[]) : [n['@type']]
      if (types.includes('fabio:Figure')) {
        const by = idList(n, 'wasGeneratedBy')[0]
        const partOf = idList(n, 'dcterms:isPartOf')[0]
        if (by && partOf) {
          figureByActivity.set(by, {
            id,
            label: String(firstValue(n, 'label') ?? id),
            partOf,
          })
        }
        continue
      }
      // 外部リソースのノードには imageDigest が無い。こちらの画像ではないので取り込まない
      if (firstValue(n, 'provision:imageDigest') === undefined) continue
      entities.push({
        id,
        label: String(firstValue(n, 'label') ?? id),
        digest: String(firstValue(n, 'provision:imageDigest') ?? ''),
        mediaType: String(firstValue(n, 'provision:mediaType') ?? 'image/png'),
        ...(firstValue(n, 'atLocation') !== undefined
          ? { location: String(firstValue(n, 'atLocation')) }
          : {}),
        ...(idList(n, 'alternateOf')[0] !== undefined
          ? { alternateOf: idList(n, 'alternateOf')[0]! }
          : {}),
      })
    } else if (t === 'SoftwareAgent' || t === 'Person' || t === 'Organization') {
      agents.push({
        id,
        label: String(firstValue(n, 'label') ?? id),
        kind: t,
        ...(firstValue(n, 'provision:role') !== undefined
          ? { role: String(firstValue(n, 'provision:role')) }
          : {}),
        ...(firstValue(n, 'provision:version') !== undefined
          ? { version: String(firstValue(n, 'provision:version')) }
          : {}),
        ...(firstValue(n, 'provision:modelFingerprint') !== undefined
          ? { modelFingerprint: String(firstValue(n, 'provision:modelFingerprint')) }
          : {}),
        ...(firstValue(n, 'provision:platform') !== undefined
          ? { platform: String(firstValue(n, 'provision:platform')) }
          : {}),
      })
    } else if (t === 'Plan') {
      plans.push({
        id,
        label: String(firstValue(n, 'label') ?? id),
        startedAtTime: String(firstValue(n, 'generatedAtTime') ?? ''),
      })
    } else if (t === 'Activity') {
      activityNodes.push(n)
    }
  }

  // Association ノードから「どの送信から走ったか」を引く（D-022）。
  // 限定表現には @id が無いので、上の分類（@id が要る）では拾えない
  for (const n of nodes) {
    if (typeOf(n) !== 'Association') continue
    const activity = idList(n, 'activity')[0]
    const plan = idList(n, 'hadPlan')[0]
    if (activity && plan) planByActivity.set(activity, plan)
  }

  // Generation ノードから「どの Activity がどの Entity を生んだか」を引く
  const generatedBy = new Map<string, string>()
  for (const n of nodes) {
    if (typeOf(n) !== 'Generation') continue
    const activity = idList(n, 'activity')[0]
    const entity = idList(n, 'entity')[0]
    if (activity && entity) generatedBy.set(activity, entity)
  }

  const num = (n: JsonLdNode, key: string): number | undefined => {
    const v = firstValue(n, key)
    if (v === undefined) return undefined
    const parsed = typeof v === 'number' ? v : Number(v)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  const str = (n: JsonLdNode, key: string): string | undefined => {
    const v = firstValue(n, key)
    return v === undefined ? undefined : String(v)
  }

  // prov:used に並んでいるうち、このグラフの画像 Entity であるものが派生元。
  // それ以外は人間が参照した外部リソース
  const localEntities = new Set(entities.map((e) => e.id))

  // provision:prompt を持たない Activity は「後から人が表明したこと」（D-008）
  const assertions: AssertionActivity[] = activityNodes
    .filter((n) => firstValue(n, 'provision:prompt') === undefined)
    .map((n) => {
      const id = n['@id'] as string
      const about = idList(n, 'provision:assertionAbout')[0] ?? idList(n, 'used')[0] ?? ''
      const referenced = idList(n, 'used')
        .filter((iri) => iri !== about)
        .sort()
      const figure = figureByActivity.get(id)
      const title = firstValue(n, 'provision:title')
      const kind: AssertionActivity['kind'] = figure
        ? 'publication'
        : title !== undefined
          ? 'title'
          : 'reference'
      return {
        id,
        kind,
        label: String(firstValue(n, 'label') ?? id),
        about,
        referenced,
        ...(figure ? { figure } : {}),
        ...(title !== undefined ? { title: String(title) } : {}),
        startedAtTime: String(firstValue(n, 'startedAtTime') ?? ''),
        wasAssociatedWith: idList(n, 'wasAssociatedWith').slice().sort(),
      }
    })

  const activities: GenerationActivity[] = activityNodes
    .filter((n) => firstValue(n, 'provision:prompt') !== undefined)
    .map((n) => {
    const id = n['@id'] as string
    const generated = generatedBy.get(id) ?? ''
    const usedAll = idList(n, 'used')
    return {
      id,
      label: String(firstValue(n, 'label') ?? id),
      prompt: str(n, 'provision:prompt') ?? '',
      model: str(n, 'provision:model') ?? '',
      seed: num(n, 'provision:seed') ?? 0,
      startedAtTime: str(n, 'startedAtTime') ?? '',
      endedAtTime: str(n, 'endedAtTime') ?? '',
      ...(str(n, 'provision:intent') !== undefined
        ? { intent: str(n, 'provision:intent')! }
        : {}),
      ...(str(n, 'provision:negativePrompt') !== undefined
        ? { negativePrompt: str(n, 'provision:negativePrompt')! }
        : {}),
      ...(num(n, 'provision:imageStrength') !== undefined
        ? { imageStrength: num(n, 'provision:imageStrength')! }
        : {}),
      ...(str(n, 'provision:conditioningImageDigest') !== undefined
        ? { conditioningImageDigest: str(n, 'provision:conditioningImageDigest')! }
        : {}),
      ...(str(n, 'provision:conditioningImageLocation') !== undefined
        ? { conditioningImageLocation: str(n, 'provision:conditioningImageLocation')! }
        : {}),
      ...(str(n, 'provision:maskImageDigest') !== undefined
        ? { maskImageDigest: str(n, 'provision:maskImageDigest')! }
        : {}),
      ...(str(n, 'provision:maskImageLocation') !== undefined
        ? { maskImageLocation: str(n, 'provision:maskImageLocation')! }
        : {}),
      ...(str(n, 'provision:commandTemplate') !== undefined
        ? { commandTemplate: str(n, 'provision:commandTemplate')! }
        : {}),
      ...(REPRODUCIBILITY_VALUES.includes(str(n, 'provision:reproducibility') ?? '')
        ? {
            reproducibility: str(
              n,
              'provision:reproducibility',
            ) as GenerationActivity['reproducibility'],
          }
        : {}),
      ...(PIXEL_ORIGIN_VALUES.includes(str(n, 'provision:pixelOrigin') ?? '')
        ? {
            pixelOrigin: str(n, 'provision:pixelOrigin') as GenerationActivity['pixelOrigin'],
          }
        : {}),
      ...(str(n, 'provision:planningMode') === 'rules' ||
      str(n, 'provision:planningMode') === 'llm'
        ? { planningMode: str(n, 'provision:planningMode') as 'rules' | 'llm' }
        : {}),
      ...(str(n, 'provision:plannerProvider') !== undefined
        ? { plannerProvider: str(n, 'provision:plannerProvider')! }
        : {}),
      ...(str(n, 'provision:plannerModel') !== undefined
        ? { plannerModel: str(n, 'provision:plannerModel')! }
        : {}),
      ...(str(n, 'provision:selectedTool') !== undefined
        ? { selectedTool: str(n, 'provision:selectedTool')! }
        : {}),
      ...(str(n, 'provision:toolArguments') !== undefined
        ? { toolArguments: str(n, 'provision:toolArguments')! }
        : {}),
      ...(str(n, 'provision:sourceFileDigest') !== undefined
        ? { sourceFileDigest: str(n, 'provision:sourceFileDigest')! }
        : {}),
      ...(str(n, 'provision:sourceFileMediaType') !== undefined
        ? { sourceFileMediaType: str(n, 'provision:sourceFileMediaType')! }
        : {}),
      ...(str(n, 'provision:sourceFileName') !== undefined
        ? { sourceFileName: str(n, 'provision:sourceFileName')! }
        : {}),
      ...(str(n, 'provision:provider') !== undefined
        ? { provider: str(n, 'provision:provider')! }
        : {}),
      ...(num(n, 'provision:steps') !== undefined ? { steps: num(n, 'provision:steps')! } : {}),
      ...(num(n, 'provision:guidance') !== undefined
        ? { guidance: num(n, 'provision:guidance')! }
        : {}),
      ...(num(n, 'provision:width') !== undefined ? { width: num(n, 'provision:width')! } : {}),
      ...(num(n, 'provision:height') !== undefined
        ? { height: num(n, 'provision:height')! }
        : {}),
      used: usedAll.filter((iri) => localEntities.has(iri)).sort(),
      referenced: usedAll.filter((iri) => !localEntities.has(iri)).sort(),
      generated,
      wasAssociatedWith: idList(n, 'wasAssociatedWith').slice().sort(),
    }
    })

  // Plan が消えている記録で planId だけ残すと、辿れない参照になる
  const known = new Set(plans.map((p) => p.id))
  for (const activity of activities) {
    const plan = planByActivity.get(activity.id)
    if (plan && known.has(plan)) activity.planId = plan
  }

  const data: ProvGraphData = { base, entities, activities, assertions, agents, plans }
  return ProvGraph.from(data)
}
