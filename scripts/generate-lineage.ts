/**
 * Step 2 — 実際に画像を生成しながら派生グラフを作る。
 *
 * 筋書きは scripts/make-figure-lineage.ts と同じ（論文 1171 の試料 CC1 の
 * グラフィカルアブストラクト）。違うのは、絵が本物であること。
 *
 *   pnpm tsx scripts/generate-lineage.ts
 *
 * 生成は直列。並行させるとピークメモリで落ちる（geo-logo の実測）。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ProvGraph } from '../src/prov/graph.js'
import type { Iri } from '../src/prov/types.js'
import { saveGraph } from '../src/prov/store.js'
import { toNTriplesText } from '../src/prov/ntriples.js'
import {
  cacheKeyOf,
  generateImage,
  modelIdOf,
  resolveImageCommand,
} from '../src/image/mflux.js'
import { sha256 } from '../src/prov/iri.js'

const ASTERISM = 'https://kumagallium.github.io/asterism/starrydata/resource'
const ZT_CURVE = `${ASTERISM}/curve/1171-318-665`
const SEEBECK_CURVE = `${ASTERISM}/curve/1171-316-665`

const OUT_DIR = 'data/run'
const IMAGE_DIR = join(OUT_DIR, 'images')
const CACHE_DIR = join(OUT_DIR, 'cache')

const BASE_PROMPT =
  'flat vector graphical abstract for a materials science paper, ' +
  'clathrate cage crystal structure, thermoelectric energy conversion, ' +
  'white background, minimal, no text'

interface StepSpec {
  label: string
  intent?: string
  prompt: string
  seed: number
  parent?: 'previous' | 'v2' | 'v3a'
  referenced?: Iri[]
}

const STEPS: StepSpec[] = [
  {
    label: 'グラフィカルアブストラクト v1',
    prompt: BASE_PROMPT,
    seed: 42,
    // 著者がこの測定曲線を見て、この図を作らせた（機械は読んでいない）
    referenced: [ZT_CURVE, SEEBECK_CURVE],
  },
  {
    label: 'グラフィカルアブストラクト v2',
    intent: '中央のケージ構造をもっと大きく',
    prompt: `${BASE_PROMPT}, large central cage structure filling the frame`,
    seed: 43,
    parent: 'previous',
  },
  {
    label: 'グラフィカルアブストラクト v3a（寒色）',
    intent: '配色を寒色に寄せて',
    prompt: `${BASE_PROMPT}, large central cage structure, cool blue and teal palette`,
    seed: 44,
    parent: 'previous',
  },
  {
    label: 'グラフィカルアブストラクト v3b（単色）',
    intent: '刷り上がりを考えて単色に',
    prompt: `${BASE_PROMPT}, large central cage structure, monochrome grayscale`,
    seed: 45,
    parent: 'v2',
  },
  {
    label: 'グラフィカルアブストラクト v4（投稿版）',
    intent: '線を太くして、縮小しても潰れないように',
    prompt: `${BASE_PROMPT}, large central cage structure, cool blue and teal palette, thick bold lines`,
    seed: 46,
    parent: 'v3a',
  },
]

const graph = new ProvGraph()
const mflux = graph.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
const me = graph.addAgent('kumagallium', 'kumagallium', 'Person')
const agents = [mflux.id, me.id]

await mkdir(IMAGE_DIR, { recursive: true })
await mkdir(CACHE_DIR, { recursive: true })

const MODEL = modelIdOf(resolveImageCommand())

/**
 * 1 枚 2〜3 分かかるので、済んだぶんはキャッシュから返す。
 * 生成そのものの記録（時刻・モデル）も一緒に残す——後から捏造できないようにする。
 */
async function generateOrReuse(input: { prompt: string; seed: number }) {
  const key = cacheKeyOf(input, MODEL)
  const png = join(CACHE_DIR, `${key}.png`)
  const meta = join(CACHE_DIR, `${key}.json`)
  if (existsSync(png) && existsSync(meta)) {
    const m = JSON.parse(await readFile(meta, 'utf8')) as {
      model: string
      provider: string
      startedAtTime: string
      endedAtTime: string
    }
    return { ...m, png: new Uint8Array(await readFile(png)), reused: true }
  }
  const result = await generateImage(input)
  await writeFile(png, result.png)
  await writeFile(
    meta,
    JSON.stringify(
      {
        model: result.model,
        provider: result.provider,
        startedAtTime: result.startedAtTime,
        endedAtTime: result.endedAtTime,
      },
      null,
      2,
    ),
    'utf8',
  )
  return { ...result, reused: false }
}

const named = new Map<string, Iri>()
let previous: Iri | undefined
let leaf: Iri | undefined

for (const [index, spec] of STEPS.entries()) {
  const parent =
    spec.parent === 'previous'
      ? previous
      : spec.parent === 'v2'
        ? named.get('v2')
        : spec.parent === 'v3a'
          ? named.get('v3a')
          : undefined

  process.stdout.write(`[${index + 1}/${STEPS.length}] ${spec.label} … `)
  const result = await generateOrReuse({ prompt: spec.prompt, seed: spec.seed })

  // 画像の置き場所は内容ハッシュで決まる。Entity の IRI と同じ由来にしておく
  const digest = sha256(result.png)
  const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
  await writeFile(path, result.png)

  const entity = graph.recordGeneration({
    location: path,
    image: result.png,
    label: spec.label,
    prompt: spec.prompt,
    model: result.model,
    provider: result.provider,
    seed: spec.seed,
    steps: 8,
    width: 1024,
    height: 1024,
    startedAtTime: result.startedAtTime,
    endedAtTime: result.endedAtTime,
    ...(spec.intent ? { intent: spec.intent } : {}),
    ...(parent ? { derivedFrom: [parent] } : {}),
    ...(spec.referenced ? { referenced: spec.referenced } : {}),
    agents,
  })

  console.log(`${entity.digest.slice(0, 12)} ${result.reused ? '(キャッシュ)' : ''} → ${path}`)

  previous = entity.id
  leaf = entity.id
  if (spec.label.includes('v2')) named.set('v2', entity.id)
  if (spec.label.includes('v3a')) named.set('v3a', entity.id)
}

await saveGraph(join(OUT_DIR, 'lineage.jsonld'), graph)
await writeFile(join(OUT_DIR, 'lineage.nt'), toNTriplesText(graph), 'utf8')
await writeFile(join(OUT_DIR, 'lineage.leaf.txt'), `${leaf}\n`, 'utf8')

console.log(
  `\nEntity=${graph.listEntities().length} Activity=${graph.listActivities().length}`,
)
console.log(`投稿版: ${leaf}`)
