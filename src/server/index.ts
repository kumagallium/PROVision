/**
 * ローカルのサーバ。画面（ブラウザ / Tauri の WebView）から生成を頼まれ、
 * グラフに記録して PROV-JSONLD を書き戻す。
 *
 * 置き場所は環境変数 PROVISION_DATA_DIR で受け取る。
 * geo-logo では .app 起動時の cwd が / になり、既定の cwd/data を作れず落ちた。
 */
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ProvGraph } from '../prov/graph.js'
import { loadGraph, saveGraph } from '../prov/store.js'
import { toNTriplesText } from '../prov/ntriples.js'
import { sha256 } from '../prov/sha256.js'
import { toProvJsonLd } from '../prov/jsonld.js'
import { cacheKeyOf, generateImage, modelIdOf, resolveImageCommand } from '../image/mflux.js'

const DATA_DIR = resolve(process.env.PROVISION_DATA_DIR ?? 'data/run')
const IMAGE_DIR = join(DATA_DIR, 'images')
const CACHE_DIR = join(DATA_DIR, 'cache')
const GRAPH_PATH = join(DATA_DIR, 'lineage.jsonld')
const PORT = Number(process.env.PROVISION_PORT ?? 8788)

await mkdir(IMAGE_DIR, { recursive: true })
await mkdir(CACHE_DIR, { recursive: true })

let graph: ProvGraph = existsSync(GRAPH_PATH)
  ? await loadGraph(GRAPH_PATH)
  : new ProvGraph()

const tool = graph.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
const person = graph.addAgent('kumagallium', 'kumagallium', 'Person')

/**
 * 生成は直列に捌く。並行させるとピークメモリで落ちる（geo-logo の実測）。
 * 画面から連打されても 1 本ずつ流す。
 */
let queue: Promise<unknown> = Promise.resolve()
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task)
  queue = run.catch(() => undefined)
  return run
}

async function persist() {
  await saveGraph(GRAPH_PATH, graph)
  await writeFile(join(DATA_DIR, 'lineage.nt'), toNTriplesText(graph), 'utf8')
}

const app = new Hono()

app.get('/api/graph', (c) => c.json(toProvJsonLd(graph)))

/** 画像を配る。ファイル名しか受け取らないので、data の外は読めない */
app.get('/api/images/:name', async (c) => {
  const name = c.req.param('name')
  if (!/^[0-9a-f]{8,64}\.png$/.test(name)) return c.notFound()
  const path = join(IMAGE_DIR, name)
  if (!existsSync(path)) return c.notFound()
  const png = await readFile(path)
  return c.body(new Uint8Array(png), 200, { 'Content-Type': 'image/png' })
})

interface GenerateBody {
  /** 利用者が書いた指示。そのまま provision:intent になる */
  intent: string
  /** 実際にモデルへ渡す文字列。省略時は親のプロンプトに intent を足す */
  prompt?: string
  /** 分岐元の画像 Entity。省略すると新しい根になる */
  parent?: string
  /** 人間が参照した外部リソース（asterism の IRI など） */
  referenced?: string[]
  seed?: number
  label?: string
}

app.post('/api/generate', async (c) => {
  const body = (await c.req.json()) as GenerateBody
  if (!body.intent?.trim() && !body.prompt?.trim()) {
    return c.json({ error: '指示が空です' }, 400)
  }

  const parentActivity = body.parent ? graph.activityThatGenerated(body.parent) : undefined
  if (body.parent && !graph.getEntity(body.parent)) {
    return c.json({ error: `その版はグラフにありません: ${body.parent}` }, 400)
  }

  // 分岐元があるなら、そのプロンプトに指示を足す。無ければ指示そのものを使う
  const prompt =
    body.prompt?.trim() ||
    (parentActivity ? `${parentActivity.prompt}, ${body.intent}` : body.intent)
  const seed = Number.isInteger(body.seed)
    ? body.seed!
    : // 同じ指示を 2 回出しても違う絵が出るように、指示から決めた値をずらす
      Number.parseInt(sha256(`${prompt}${Date.now()}`).slice(0, 8), 16) % 2 ** 31

  try {
    const entity = await serial(async () => {
      const model = modelIdOf(resolveImageCommand())
      const key = cacheKeyOf({ prompt, seed }, model)
      const cachedPng = join(CACHE_DIR, `${key}.png`)
      const cachedMeta = join(CACHE_DIR, `${key}.json`)

      let result: {
        png: Uint8Array
        model: string
        provider: string
        startedAtTime: string
        endedAtTime: string
      }
      if (existsSync(cachedPng) && existsSync(cachedMeta)) {
        const meta = JSON.parse(await readFile(cachedMeta, 'utf8'))
        result = { ...meta, png: new Uint8Array(await readFile(cachedPng)) }
      } else {
        result = await generateImage({ prompt, seed })
        await writeFile(cachedPng, result.png)
        await writeFile(
          cachedMeta,
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
      }

      const digest = sha256(result.png)
      const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
      await writeFile(path, result.png)

      const recorded = graph.recordGeneration({
        image: result.png,
        label: body.label?.trim() || body.intent || '無題',
        location: `images/${digest.slice(0, 16)}.png`,
        prompt,
        model: result.model,
        provider: result.provider,
        seed,
        steps: 8,
        width: 1024,
        height: 1024,
        startedAtTime: result.startedAtTime,
        endedAtTime: result.endedAtTime,
        ...(body.intent?.trim() ? { intent: body.intent } : {}),
        ...(body.parent ? { derivedFrom: [body.parent] } : {}),
        ...(body.referenced?.length ? { referenced: body.referenced } : {}),
        agents: [tool.id, person.id],
      })
      await persist()
      return recorded
    })

    return c.json({ entity, graph: toProvJsonLd(graph) })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return c.json({ error: why }, 500)
  }
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PROVision server: http://127.0.0.1:${info.port}  data=${DATA_DIR}`)
})
