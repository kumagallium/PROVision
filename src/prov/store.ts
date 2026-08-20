/**
 * グラフの永続化。DB もサーバも要らない。PROV-JSONLD を 1 ファイルに書くだけ。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { ProvGraph } from './graph.js'
import { fromProvJsonLd, toProvJsonLd, type ProvJsonLdDocument } from './jsonld.js'
import { DEFAULT_BASE } from './iri.js'

export async function saveGraph(path: string, graph: ProvGraph): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const doc = toProvJsonLd(graph)
  await writeFile(path, `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

export async function loadGraph(path: string, base: string = DEFAULT_BASE): Promise<ProvGraph> {
  const raw = await readFile(path, 'utf8')
  const doc = JSON.parse(raw) as ProvJsonLdDocument
  return fromProvJsonLd(doc, base)
}
