/**
 * Step 3 の題材。asterism のデモデータに実在する IRI を参照した図版の系譜を作る。
 *
 * 筋書き: 論文 1171（Ba8Al14Si31 クラスレート）の試料 CC1 の測定曲線を見ながら、
 * グラフィカルアブストラクト用の概念図を 4 世代作り直した。
 *
 * 曲線への辺は「機械が消費した」ではなく「著者が参照した」として prov:used だけ張る。
 * 責任者は人間 Agent（D-006）。
 *
 *   pnpm tsx scripts/make-figure-lineage.ts
 */
import { ProvGraph } from '../src/prov/graph.js'
import { saveGraph } from '../src/prov/store.js'
import { toNTriplesText } from '../src/prov/ntriples.js'
import { writeFile, mkdir } from 'node:fs/promises'

const ASTERISM = 'https://kumagallium.github.io/asterism/starrydata/resource'
const ZT_CURVE = `${ASTERISM}/curve/1171-318-665`
const SEEBECK_CURVE = `${ASTERISM}/curve/1171-316-665`

const bytes = (s: string) => new TextEncoder().encode(s)

const g = new ProvGraph()
const mflux = g.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
const me = g.addAgent('kumagallium', 'kumagallium', 'Person')
const agents = [mflux.id, me.id]

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
  image: bytes('ga-v1'),
  label: 'グラフィカルアブストラクト v1',
  prompt:
    'flat vector graphical abstract of a clathrate thermoelectric material, ' +
    'ZT rising with temperature, white background',
  seed: 42,
  // 著者が見ていた曲線。機械はこれを読んでいない
  referenced: [ZT_CURVE, SEEBECK_CURVE],
  startedAtTime: '2026-08-20T09:00:00Z',
  endedAtTime: '2026-08-20T09:00:14Z',
})

const v2 = g.recordGeneration({
  ...common,
  image: bytes('ga-v2'),
  label: 'グラフィカルアブストラクト v2',
  intent: '中央のケージ構造をもっと大きく',
  prompt:
    'flat vector graphical abstract of a clathrate thermoelectric material, ' +
    'large central cage structure, ZT rising with temperature',
  seed: 43,
  derivedFrom: [v1.id],
  startedAtTime: '2026-08-20T09:06:00Z',
  endedAtTime: '2026-08-20T09:06:13Z',
})

const v3a = g.recordGeneration({
  ...common,
  image: bytes('ga-v3a'),
  label: 'グラフィカルアブストラクト v3a（寒色）',
  intent: '配色を寒色に寄せて',
  prompt:
    'flat vector graphical abstract ..., large central cage structure, cool palette',
  seed: 44,
  derivedFrom: [v2.id],
  startedAtTime: '2026-08-20T09:12:00Z',
  endedAtTime: '2026-08-20T09:12:11Z',
})

g.recordGeneration({
  ...common,
  image: bytes('ga-v3b'),
  label: 'グラフィカルアブストラクト v3b（単色）',
  intent: '刷り上がりを考えて単色に',
  prompt: 'flat vector graphical abstract ..., large central cage structure, monochrome',
  seed: 45,
  derivedFrom: [v2.id],
  startedAtTime: '2026-08-20T09:15:00Z',
  endedAtTime: '2026-08-20T09:15:10Z',
})

const v4 = g.recordGeneration({
  ...common,
  image: bytes('ga-v4'),
  label: 'グラフィカルアブストラクト v4（投稿版）',
  intent: '温度軸のラベルが読めるように、線を太く',
  prompt:
    'flat vector graphical abstract ..., cool palette, thick lines, legible axis labels',
  seed: 46,
  derivedFrom: [v3a.id],
  startedAtTime: '2026-08-20T09:22:00Z',
  endedAtTime: '2026-08-20T09:22:15Z',
})

await mkdir('data', { recursive: true })
await saveGraph('data/figure-lineage.jsonld', g)
await writeFile('data/figure-lineage.nt', toNTriplesText(g), 'utf8')
await writeFile('data/figure-lineage.leaf.txt', `${v4.id}\n`, 'utf8')

console.log(`Entity=${g.listEntities().length} Activity=${g.listActivities().length}`)
console.log(`投稿版: ${v4.id}`)
console.log('data/figure-lineage.jsonld / .nt を書き出した')
