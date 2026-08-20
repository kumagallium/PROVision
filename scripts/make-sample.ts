/**
 * 動作確認用のサンプルグラフを書き出す。
 * prov-jsonld-viz で開けるかを目で確かめるための道具。
 *
 *   pnpm tsx scripts/make-sample.ts data/sample.provision.jsonld
 */
import { ProvGraph } from '../src/prov/graph.js'
import { saveGraph } from '../src/prov/store.js'

const out = process.argv[2] ?? 'data/sample.provision.jsonld'
const bytes = (s: string) => new TextEncoder().encode(s)

const g = new ProvGraph()
const tool = g.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
const me = g.addAgent('kumagallium', 'kumagallium', 'Person')
const agents = [tool.id, me.id]

const common = {
  model: 'z-image-turbo-4bit',
  provider: 'command:mflux',
  width: 1024,
  height: 1024,
  steps: 8,
  agents,
}

const v1 = g.recordGeneration({
  ...common,
  image: bytes('fig-v1'),
  label: '概念図 v1',
  prompt: 'flat vector concept diagram of a thermoelectric module, white background',
  seed: 42,
  startedAtTime: '2026-08-20T10:00:00Z',
  endedAtTime: '2026-08-20T10:00:12Z',
})

const v2 = g.recordGeneration({
  ...common,
  image: bytes('fig-v2'),
  label: '概念図 v2（余白）',
  intent: 'もっと余白を取って',
  prompt: 'flat vector concept diagram of a thermoelectric module, generous margins',
  seed: 43,
  derivedFrom: [v1.id],
  startedAtTime: '2026-08-20T10:05:00Z',
  endedAtTime: '2026-08-20T10:05:11Z',
})

const v3a = g.recordGeneration({
  ...common,
  image: bytes('fig-v3a'),
  label: '概念図 v3a（寒色）',
  intent: '配色を寒色に寄せて',
  prompt: 'flat vector concept diagram ..., generous margins, cool palette',
  seed: 44,
  derivedFrom: [v2.id],
  startedAtTime: '2026-08-20T10:09:00Z',
  endedAtTime: '2026-08-20T10:09:10Z',
})

g.recordGeneration({
  ...common,
  image: bytes('fig-v3b'),
  label: '概念図 v3b（単色）',
  intent: '刷り上がりを考えて単色に',
  prompt: 'flat vector concept diagram ..., generous margins, monochrome',
  seed: 45,
  derivedFrom: [v2.id],
  startedAtTime: '2026-08-20T10:11:00Z',
  endedAtTime: '2026-08-20T10:11:09Z',
})

g.recordGeneration({
  ...common,
  image: bytes('fig-v4'),
  label: '概念図 v4（掲載版）',
  intent: '矢印を太くして、掲載用に',
  prompt: 'flat vector concept diagram ..., cool palette, thick arrows',
  seed: 46,
  derivedFrom: [v3a.id],
  startedAtTime: '2026-08-20T10:20:00Z',
  endedAtTime: '2026-08-20T10:20:13Z',
})

await saveGraph(out, g)
console.log(
  `書き出した: ${out}  Entity=${g.listEntities().length} Activity=${g.listActivities().length}`,
)
