/**
 * PROV-JSONLD の読み書き。
 *
 * 形は openprovenance の PROV-JSONLD に合わせる（D-005）。
 * 関係は実体ノード（Usage / Generation / Association）として書き、
 * 併せて Entity / Activity 側に素の PROV プロパティ
 * （wasDerivedFrom / wasGeneratedBy / used / wasAssociatedWith）も持たせる。
 * 前者は prov-jsonld-viz が辺を描くため、後者は SPARQL が素直に書けるため。
 */
import type { GenerationActivity, ImageEntity, ProvAgent, ProvGraphData } from './types.js'
import { ProvGraph } from './graph.js'

export const PROVISION_CONTEXT_URL =
  'https://kumagallium.github.io/provision-schema/context.jsonld'

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

function entityNode(e: ImageEntity, derivedFrom: string[], generatedBy?: string): JsonLdNode {
  return {
    '@id': e.id,
    '@type': 'Entity',
    label: lit(e.label),
    'provision:imageDigest': lit(e.digest),
    'provision:mediaType': lit(e.mediaType),
    ...(e.location ? { atLocation: lit(e.location) } : {}),
    ...(derivedFrom.length > 0 ? { wasDerivedFrom: refs(derivedFrom) } : {}),
    ...(generatedBy ? { wasGeneratedBy: refs([generatedBy]) } : {}),
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

function agentNode(agent: ProvAgent): JsonLdNode {
  return {
    '@id': agent.id,
    '@type': agent.kind === 'SoftwareAgent' ? 'SoftwareAgent' : agent.kind,
    label: lit(agent.label),
  }
}

export function toProvJsonLd(graph: ProvGraph): ProvJsonLdDocument {
  const data = graph.toData()
  const nodes: JsonLdNode[] = []

  for (const agent of data.agents) nodes.push(agentNode(agent))

  for (const e of data.entities) {
    const act = graph.activityThatGenerated(e.id)
    nodes.push(entityNode(e, act?.used ?? [], act?.id))
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

  for (const a of data.activities) nodes.push(activityNode(a))

  // 関係は実体ノードとしても並べる（viz が辺を描くのはこちら）。
  // @id は付けない。付けると viz が関係そのものを孤立ノードとして描いてしまう
  for (const a of data.activities) {
    for (const used of [...a.used, ...a.referenced]) {
      nodes.push({ '@type': 'Usage', activity: a.id, entity: used })
    }
    nodes.push({ '@type': 'Generation', activity: a.id, entity: a.generated })
    for (const agent of a.wasAssociatedWith) {
      nodes.push({ '@type': 'Association', activity: a.id, agent })
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

  for (const n of nodes) {
    const t = typeOf(n)
    const id = typeof n['@id'] === 'string' ? (n['@id'] as string) : ''
    if (!id) continue

    if (t === 'Entity') {
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
      })
    } else if (t === 'SoftwareAgent' || t === 'Person' || t === 'Organization') {
      agents.push({ id, label: String(firstValue(n, 'label') ?? id), kind: t })
    } else if (t === 'Activity') {
      activityNodes.push(n)
    }
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

  const activities: GenerationActivity[] = activityNodes.map((n) => {
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

  const data: ProvGraphData = { base, entities, activities, agents }
  return ProvGraph.from(data)
}
