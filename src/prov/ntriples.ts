/**
 * N-Triples への書き出し。asterism（Oxigraph）に載せるための出口。
 *
 * JSON-LD ライブラリで展開する手も考えたが、@context をネットワークから取りに行く。
 * グラフの形は完全にこちらが決めているので、素の PROV の IRI を直接書く方が
 * 決定論的で、テストしやすく、オフラインで動く。
 */
import type { ProvGraph } from './graph.js'

const PROV = 'http://www.w3.org/ns/prov#'
const PROVISION = 'https://kumagallium.github.io/PROVision/schema/context.jsonld#'
const FABIO = 'http://purl.org/spar/fabio/'
const DCTERMS = 'http://purl.org/dc/terms/'
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#'
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#'
const XSD = 'http://www.w3.org/2001/XMLSchema#'

const iri = (v: string) => `<${v}>`

function literal(value: string | number, datatype?: string): string {
  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return datatype ? `"${escaped}"^^<${datatype}>` : `"${escaped}"`
}

/** グラフを N-Triples の行の配列にする。行は決定論的に並ぶ。 */
export function toNTriples(graph: ProvGraph): string[] {
  const out: string[] = []
  const triple = (s: string, p: string, o: string) => out.push(`${s} ${p} ${o} .`)

  for (const agent of graph.listAgents()) {
    const s = iri(agent.id)
    triple(s, iri(`${RDF}type`), iri(`${PROV}${agent.kind}`))
    triple(s, iri(`${RDF}type`), iri(`${PROV}Agent`))
    triple(s, iri(`${RDFS}label`), literal(agent.label))
  }

  for (const e of graph.listEntities()) {
    const s = iri(e.id)
    triple(s, iri(`${RDF}type`), iri(`${PROV}Entity`))
    triple(s, iri(`${RDFS}label`), literal(e.label))
    triple(s, iri(`${PROVISION}imageDigest`), literal(e.digest))
    triple(s, iri(`${PROVISION}mediaType`), literal(e.mediaType))
    if (e.location) triple(s, iri(`${PROV}atLocation`), literal(e.location))

    const act = graph.activityThatGenerated(e.id)
    if (act) {
      triple(s, iri(`${PROV}wasGeneratedBy`), iri(act.id))
      // 派生は画像の親だけ。人間が参照した外部リソースには張らない（D-006）
      for (const parent of act.used) {
        triple(s, iri(`${PROV}wasDerivedFrom`), iri(parent))
      }
      for (const agent of act.wasAssociatedWith) {
        triple(s, iri(`${PROV}wasAttributedTo`), iri(agent))
      }
    }
  }

  for (const a of graph.listActivities()) {
    const s = iri(a.id)
    triple(s, iri(`${RDF}type`), iri(`${PROV}Activity`))
    triple(s, iri(`${RDFS}label`), literal(a.label))
    triple(s, iri(`${PROV}startedAtTime`), literal(a.startedAtTime, `${XSD}dateTime`))
    triple(s, iri(`${PROV}endedAtTime`), literal(a.endedAtTime, `${XSD}dateTime`))
    triple(s, iri(`${PROVISION}prompt`), literal(a.prompt))
    triple(s, iri(`${PROVISION}model`), literal(a.model))
    triple(s, iri(`${PROVISION}seed`), literal(a.seed, `${XSD}integer`))
    if (a.intent) triple(s, iri(`${PROVISION}intent`), literal(a.intent))
    if (a.negativePrompt) {
      triple(s, iri(`${PROVISION}negativePrompt`), literal(a.negativePrompt))
    }
    if (a.provider) triple(s, iri(`${PROVISION}provider`), literal(a.provider))
    for (const [key, value] of [
      ['steps', a.steps],
      ['width', a.width],
      ['height', a.height],
    ] as const) {
      if (value !== undefined) {
        triple(s, iri(`${PROVISION}${key}`), literal(value, `${XSD}integer`))
      }
    }
    if (a.guidance !== undefined) {
      triple(s, iri(`${PROVISION}guidance`), literal(a.guidance, `${XSD}decimal`))
    }
    for (const used of [...a.used, ...a.referenced]) {
      triple(s, iri(`${PROV}used`), iri(used))
    }
    for (const agent of a.wasAssociatedWith) {
      triple(s, iri(`${PROV}wasAssociatedWith`), iri(agent))
    }
    triple(iri(a.generated), iri(`${PROV}wasGeneratedBy`), iri(a.id))
  }

  // 後から人が表明したこと（D-008）。生成の記録とは別の Activity として書く
  for (const a of graph.listAssertions()) {
    const s = iri(a.id)
    triple(s, iri(`${RDF}type`), iri(`${PROV}Activity`))
    triple(s, iri(`${RDFS}label`), literal(a.label))
    triple(s, iri(`${PROV}startedAtTime`), literal(a.startedAtTime, `${XSD}dateTime`))
    triple(s, iri(`${PROV}used`), iri(a.about))
    for (const ref of a.referenced) triple(s, iri(`${PROV}used`), iri(ref))
    for (const agent of a.wasAssociatedWith) {
      triple(s, iri(`${PROV}wasAssociatedWith`), iri(agent))
    }
    if (a.figure) {
      const f = iri(a.figure.id)
      triple(f, iri(`${RDF}type`), iri(`${PROV}Entity`))
      triple(f, iri(`${RDF}type`), iri(`${FABIO}Figure`))
      triple(f, iri(`${RDFS}label`), literal(a.figure.label))
      triple(f, iri(`${DCTERMS}identifier`), literal(a.figure.label))
      triple(f, iri(`${DCTERMS}isPartOf`), iri(a.figure.partOf))
      triple(f, iri(`${PROV}wasGeneratedBy`), s)
      // 載った図版は、その版の画像から出てきたもの。ここは派生で正しい
      triple(f, iri(`${PROV}wasDerivedFrom`), iri(a.about))
    }
  }

  return [...new Set(out)].sort()
}

export function toNTriplesText(graph: ProvGraph): string {
  return `${toNTriples(graph).join('\n')}\n`
}
