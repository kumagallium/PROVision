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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ProvGraph, UnchangedImageError } from '../prov/graph.js'
import {
  imageToolExecutor,
  imageToolPixelOrigin,
  imageToolReproducibility,
} from '../ai/tools.js'
import { loadGraph, saveGraph } from '../prov/store.js'
import { migrateConfigFiles } from './config-dir.js'
import { toNTriplesText } from '../prov/ntriples.js'
import { sha256 } from '../prov/sha256.js'
import { toProvJsonLd } from '../prov/jsonld.js'
import {
  DEFAULT_STEPS,
  cacheKeyOf,
  generateImage,
  modelIdOf,
  resolveImageCommand,
  resolveImageEditCommand,
  type GenerateResult,
} from '../image/mflux.js'
import { probePlatform } from '../image/environment.js'
import { addSoftwareAgent, commandTemplateOf, probeToolEnvironment } from './agents.js'
import { resolveInpaintCommand } from '../image/lama.js'
import { imageContentDigest, pngDimensions } from '../image/png.js'
import { MAX_IMPORT_BYTES, baseFileName, importImage } from '../image/import.js'
import { composeSources } from '../image/compose.js'
import { promptForImageGeneration } from '../image/prompt.js'
import { inpaintCacheKeyOf, inpaintImage } from '../image/lama.js'
import {
  backgroundRemovalCacheKeyOf,
  removeBackground,
  resolveBackgroundRemovalCommand,
} from '../image/background.js'
import {
  processStandardImage,
  standardImageCacheKeyOf,
  type StandardImageInput,
} from '../image/standard.js'
import type { ImageEntity } from '../prov/types.js'
import {
  MAX_VARIANTS,
  SynthesisForbiddenError,
  asksForMultipleCandidates,
  planImageOperation,
  proposeVariantPrompts,
  type ImageToolName,
  type PlannedImageOperation,
  validateImagePlan,
} from '../ai/planner.js'
import {
  modelCredentials,
  plannerCredentials,
  publicAiModelRegistry,
  registerAiModel,
  removeAiModel,
  updateAiModelSelection,
} from '../ai/config.js'
import {
  fetchAvailableModels,
  isAiProvider,
  resolveAiApiBase,
} from '../ai/provider.js'

const DATA_DIR = resolve(process.env.PROVISION_DATA_DIR ?? 'data/run')
/**
 * 設定の置き場。成果物とは分ける（config-dir.ts に理由）。
 * 環境変数が無いときは成果物と同じ場所——開発中はここが一番迷わない。
 */
const CONFIG_DIR = resolve(process.env.PROVISION_CONFIG_DIR ?? DATA_DIR)
const IMAGE_DIR = join(DATA_DIR, 'images')
const CACHE_DIR = join(DATA_DIR, 'cache')
const GRAPH_PATH = join(DATA_DIR, 'lineage.jsonld')
const PORT = Number(process.env.PROVISION_PORT ?? 8788)
const IMAGE_EDIT_STRENGTH = 0.3

/** 融合で渡すのは材料を並べた 1 枚。並んだままの絵が返らないよう、そう伝える（D-021） */
const COMPOSE_HINT =
  'The input image is a montage of the source images placed side by side. Merge them into one coherent image, not a collage.'
const MAX_CONDITIONING_IMAGE_BYTES = 12 * 1024 * 1024

await mkdir(IMAGE_DIR, { recursive: true })
await mkdir(CACHE_DIR, { recursive: true })

// 置き場を分ける前に登録した設定を持ち越す。複製なので旧版へ戻しても失われない
{
  const moved = await migrateConfigFiles(DATA_DIR, CONFIG_DIR)
  if (moved.copied.length > 0) {
    console.log(`[config] 旧置き場から引き継ぎました: ${moved.copied.join(', ')}`)
  }
  for (const { name, reason } of moved.failed) {
    console.warn(`[config] ${name} を引き継げませんでした（${reason}）`)
  }
}

let graph: ProvGraph = existsSync(GRAPH_PATH)
  ? await loadGraph(GRAPH_PATH)
  : new ProvGraph()

/**
 * この PC の機種・チップ・OS。起動時に 1 回だけ実測する（D-015）。
 * 取れなければ `undefined` のままで、その場合は来歴に書かない。
 */
const PLATFORM = await probePlatform()

/** コマンド雛形の解決先。差し替え可能な形で 1 か所にまとめる */
const RESOLVERS = {
  generate: () => resolveImageCommand(),
  edit: () => resolveImageEditCommand(),
  inpaint: () => resolveInpaintCommand(),
  background: () => resolveBackgroundRemovalCommand(),
}

const imageTool = addSoftwareAgent(
  graph,
  'mflux',
  'mflux (z-image-turbo-4bit)',
  await probeToolEnvironment(() => resolveImageCommand(), ['mflux', 'mlx'], PLATFORM),
)
const inpaintTool = addSoftwareAgent(
  graph,
  'lama',
  'LaMa via IOPaint',
  await probeToolEnvironment(() => resolveInpaintCommand(), ['iopaint', 'torch'], PLATFORM),
)
// Jimp はアプリに同梱されるので、版は PROVision 自身の版と一致する。
// 確定的なツールなので platform は絵に効かないが、食い違いの切り分けには要る
const standardTool = addSoftwareAgent(graph, 'jimp', 'Jimp standard image processing', {
  platform: PLATFORM,
})
const backgroundTool = addSoftwareAgent(
  graph,
  'rembg',
  'rembg (U\u00b2-Net)',
  await probeToolEnvironment(
    () => resolveBackgroundRemovalCommand(),
    ['rembg', 'onnxruntime'],
    PLATFORM,
  ),
)
const rulesPlanner = graph.addAgent('image-router-rules', 'PROVision image routing rules')

/**
 * 来歴の author。**自己申告で、検証はしない。**
 *
 * PROV の `prov:wasAssociatedWith` に載る人間 Agent がこれである。
 * D-006 で「データを参照したという主張の責任者は人間 Agent」と決めたので、
 * 誰なのかを名乗れないと、その主張の宛先が無くなる。
 */
interface Identity {
  name: string
  email: string
}

const IDENTITY_PATH = join(CONFIG_DIR, 'identity.json')
const POLICY_PATH = join(CONFIG_DIR, 'policy.json')

/**
 * 画素を作る操作を禁じるか（D-020）。**この設定自体は来歴へ書かない。**
 * 記録するのは実際に実行されたものだけで、「そのとき設定がこうだった」は
 * 何が実行されたかより弱い主張である。系譜の pixelOrigin を見れば、
 * 画素を作る手が 1 本も無いことは確定的に言える。
 */
async function readPolicy(): Promise<{ forbidSynthesis: boolean }> {
  if (!existsSync(POLICY_PATH)) return { forbidSynthesis: false }
  try {
    const raw = JSON.parse(await readFile(POLICY_PATH, 'utf8')) as { forbidSynthesis?: unknown }
    return { forbidSynthesis: raw.forbidSynthesis === true }
  } catch {
    return { forbidSynthesis: false }
  }
}

async function readIdentity(): Promise<Identity> {
  if (!existsSync(IDENTITY_PATH)) return { name: '', email: '' }
  try {
    const raw = JSON.parse(await readFile(IDENTITY_PATH, 'utf8')) as Partial<Identity>
    return { name: raw.name ?? '', email: raw.email ?? '' }
  } catch {
    return { name: '', email: '' }
  }
}

/** 人間 Agent の IRI に使う識別子。メールがあればそれを、無ければ名前を種にする */
function personSlug(identity: Identity): string {
  const seed = identity.email.trim() || identity.name.trim()
  return seed ? sha256(seed.toLowerCase()).slice(0, 16) : 'anonymous'
}

async function personAgent() {
  const identity = await readIdentity()
  return graph.addAgent(
    personSlug(identity),
    identity.name.trim() || identity.email.trim() || '名乗っていない利用者',
    'Person',
  )
}

interface SourceImage {
  path: string
  digest: string
}

function imageFileOf(location: string, digest: string): SourceImage {
  const name = location.split('/').pop()
  if (!name || !/^[0-9a-f]{8,64}\.png$/.test(name)) {
    throw new Error(`画像ファイルの場所が不正: ${location}`)
  }
  const path = join(IMAGE_DIR, name)
  if (!existsSync(path)) {
    throw new Error(`画像ファイルが見つからない: ${path}`)
  }
  return { path, digest }
}

/** 記録された画像を引く。消えていても生成を止めず、親から作り直させる */
function tryImageFile(location: string, digest: string): SourceImage | undefined {
  try {
    return imageFileOf(location, digest)
  } catch {
    return undefined
  }
}

/** 記録された引数を読む。壊れていても生成を止めない */
function parsedToolArguments(raw: string | undefined): { text?: string } {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as { text?: unknown }
    return typeof parsed.text === 'string' ? { text: parsed.text } : {}
  } catch {
    return {}
  }
}

function sourceImageOf(entityId: string): SourceImage {
  const entity = graph.getEntity(entityId)
  if (!entity?.location) {
    throw new Error(`親画像のファイル場所が記録されていない: ${entityId}`)
  }
  return imageFileOf(entity.location, entity.digest)
}

function isStandardTool(tool: ImageToolName): tool is StandardImageInput['tool'] {
  return imageToolExecutor(tool) === 'jimp'
}

function executorAgent(tool: ImageToolName) {
  switch (imageToolExecutor(tool)) {
    case 'inpaint':
      return inpaintTool
    case 'background':
      return backgroundTool
    case 'jimp':
      return standardTool
    case 'import':
      // 取り込みは PNG をそのまま通すことがあり、そのときは何も走っていない。
      // 走ったかを知っているのは取り込み側だけなので、Agent はあちらで決める
      throw new Error('取り込みの Agent は /api/import が決めます')
    default:
      return imageTool
  }
}

function plannerAgent(planning: PlannedImageOperation) {
  if (planning.mode === 'rules') return rulesPlanner
  return graph.addAgent(
    `image-router-${sha256(
      `${planning.plannerProvider ?? 'unknown'}:${planning.plannerModel ?? 'unknown'}`,
    ).slice(0, 12)}`,
    `Image router: ${planning.plannerProvider ?? 'unknown'} / ${
      planning.plannerModel ?? 'unknown'
    }`,
  )
}

function decodePngDataUrl(value: string): Uint8Array {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || value.length > MAX_CONDITIONING_IMAGE_BYTES * 2) {
    throw new Error('編集用の画像データが不正です')
  }
  const bytes = Buffer.from(match[1]!, 'base64')
  const pngMagic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (
    bytes.length === 0 ||
    bytes.length > MAX_CONDITIONING_IMAGE_BYTES ||
    !pngMagic.every((byte, index) => bytes[index] === byte)
  ) {
    throw new Error('編集用の画像はPNGで、サイズは12MB以下にしてください')
  }
  return new Uint8Array(bytes)
}

/**
 * 取り込み用のデコーダ。**形式は名乗りで決めない**——data URL のヘッダも拡張子も
 * 画面から来た自己申告で、中身と食い違いうる。判定は importImage が中身で行う
 */
function decodeImageDataUrl(value: string): Uint8Array {
  const match = /^data:[^;,]*;base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
  if (!match || value.length > MAX_IMPORT_BYTES * 2) {
    throw new Error('画像データが不正です')
  }
  return new Uint8Array(Buffer.from(match[1]!, 'base64'))
}

/** 材料を横に並べた 1 枚を保存する（D-021）。確定的なので同じ材料なら同じファイルになる */
async function storeComposedImage(sources: readonly SourceImage[]): Promise<SourceImage> {
  const png = await composeSources({
    paths: sources.map((item) => item.path),
    digests: sources.map((item) => item.digest),
  })
  const digest = imageContentDigest(png)
  const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
  if (!existsSync(path)) await writeFile(path, png)
  return { path, digest }
}

async function storePngDataUrl(dataUrl: string): Promise<SourceImage> {
  const bytes = decodePngDataUrl(dataUrl)
  const digest = imageContentDigest(bytes)
  const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
  if (!existsSync(path)) await writeFile(path, bytes)
  return { path, digest }
}

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

/**
 * 生きているかと、どの版のサイドカーかを返す。
 *
 * 配布パイプラインの smoke test がここを叩く。自動更新の直後に旧版のサイドカーが
 * ポートを握ったまま生き残ると、新しい API が 404 になる——画面はこの版を見て
 * 食い違いに気づける。
 */
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    pid: process.pid,
    version: process.env.PROVISION_APP_VERSION ?? 'dev',
    dataDir: DATA_DIR,
  }),
)

app.get('/api/graph', (c) => c.json(toProvJsonLd(graph)))

app.get('/api/identity', async (c) => c.json(await readIdentity()))

app.get('/api/policy', async (c) => c.json(await readPolicy()))

app.put('/api/policy', async (c) => {
  const body = (await c.req.json()) as { forbidSynthesis?: unknown }
  const policy = { forbidSynthesis: body.forbidSynthesis === true }
  await writeFile(POLICY_PATH, JSON.stringify(policy, null, 2), 'utf8')
  return c.json(policy)
})

app.put('/api/identity', async (c) => {
  const body = (await c.req.json()) as Partial<Identity>
  const identity: Identity = {
    name: String(body.name ?? '').slice(0, 200),
    email: String(body.email ?? '').slice(0, 200),
  }
  await writeFile(IDENTITY_PATH, `${JSON.stringify(identity, null, 2)}\n`, 'utf8')
  return c.json(identity)
})

app.get('/api/ai/models', async (c) => {
  try {
    return c.json(await publicAiModelRegistry(CONFIG_DIR))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.put('/api/ai/planner', async (c) => {
  try {
    return c.json(await updateAiModelSelection(CONFIG_DIR, await c.req.json()))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post('/api/ai/models', async (c) => {
  try {
    const body = (await c.req.json()) as {
      name?: unknown
      provider?: unknown
      modelId?: unknown
      apiBase?: unknown
      apiKey?: unknown
      replaceId?: unknown
    }
    if (!isAiProvider(body.provider)) {
      return c.json({ error: '対応していないAIプロバイダーです' }, 400)
    }
    return c.json(
      await registerAiModel(CONFIG_DIR, {
        name: String(body.name ?? ''),
        provider: body.provider,
        modelId: String(body.modelId ?? ''),
        apiBase: resolveAiApiBase({
          provider: body.provider,
          apiBase: String(body.apiBase ?? ''),
        }),
        apiKey: String(body.apiKey ?? ''),
        replaceId: String(body.replaceId ?? ''),
      }),
    )
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.delete('/api/ai/models/:id', async (c) => {
  try {
    return c.json(await removeAiModel(CONFIG_DIR, c.req.param('id')))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

interface AiConnectionInput {
  provider?: unknown
  apiBase?: unknown
  apiKey?: unknown
  reuseModelId?: unknown
}

async function aiConnectionFromInput(body: AiConnectionInput) {
  if (!isAiProvider(body.provider)) {
    throw new Error('対応していないAIプロバイダーです')
  }
  const apiBase = String(body.apiBase ?? '').trim()
  const normalizedApiBase = resolveAiApiBase({ provider: body.provider, apiBase })
  let reusedApiKey = ''
  const reuseModelId = String(body.reuseModelId ?? '').trim()
  if (reuseModelId) {
    const saved = await modelCredentials(CONFIG_DIR, reuseModelId)
    const sameEndpoint =
      saved.provider === body.provider && resolveAiApiBase(saved) === normalizedApiBase
    if (!sameEndpoint) throw new Error('保存済みモデルと接続先が一致しません')
    reusedApiKey = saved.apiKey
  }
  const apiKey = String(body.apiKey ?? '').trim() || reusedApiKey
  return { provider: body.provider, apiBase: normalizedApiBase, apiKey }
}

app.post('/api/ai/planner/models', async (c) => {
  try {
    const connection = await aiConnectionFromInput((await c.req.json()) as AiConnectionInput)
    const models = await fetchAvailableModels({ ...connection, signal: c.req.raw.signal })
    return c.json({ models })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post('/api/ai/planner/test', async (c) => {
  try {
    const body = (await c.req.json()) as AiConnectionInput & { modelId?: unknown }
    const connection = await aiConnectionFromInput(body)
    const modelId = String(body.modelId ?? '').trim()
    if (!modelId) return c.json({ error: '接続テストするモデルを選んでください' }, 400)
    const planned = await planImageOperation({
      intent: 'Make the existing image slightly warmer without changing its composition.',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: { ...connection, enabled: true, modelId },
      signal: c.req.raw.signal,
    })
    if (planned.warning) return c.json({ error: planned.warning }, 400)
    if (planned.mode !== 'llm') {
      return c.json({ error: 'AIプランナーへの接続を確認できませんでした' }, 400)
    }
    return c.json(planned)
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

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
  /** 利用者が指定範囲を消去した、編集用のPNG data URL */
  maskedImage?: string
  /** 利用者が指定した編集範囲を示す二値マスクのPNG data URL */
  maskImage?: string
  /** 人間が参照した外部リソース（asterism の IRI など） */
  referenced?: string[]
  seed?: number
  label?: string
  /** 1 回の送信で出す候補の数（D-018）。1〜MAX_VARIANTS */
  variants?: number
  /** 材料として足す別の画像（D-021）。parent と合わせて融合する */
  extraParents?: string[]
  /** 画面で引いた矢印（D-020）。位置は画像の大きさに対する％ */
  arrow?: { x1?: number; y1?: number; x2?: number; y2?: number; text?: string }
}

/** 一度に足せる材料の数。parent と合わせて 4 枚まで */
const MAX_EXTRA_SOURCES = 3

/**
 * 「この版はこのデータに基づく」と後から表明する。
 * 生成の記録は書き換えない（D-008）。
 */
app.post('/api/reference', async (c) => {
  const body = (await c.req.json()) as { entity?: string; referenced?: string[] }
  try {
    graph.assertReference({
      about: String(body.entity ?? ''),
      referenced: body.referenced ?? [],
      at: new Date().toISOString(),
      agents: [(await personAgent()).id],
    })
    await persist()
    return c.json({ graph: toProvJsonLd(graph) })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

/** 「この版が、この論文の Figure N として載った」と表明する */
app.post('/api/publication', async (c) => {
  const body = (await c.req.json()) as {
    entity?: string
    figureLabel?: string
    partOf?: string
  }
  try {
    graph.assertPublication({
      about: String(body.entity ?? ''),
      figureLabel: String(body.figureLabel ?? ''),
      partOf: String(body.partOf ?? ''),
      at: new Date().toISOString(),
      agents: [(await personAgent()).id],
    })
    await persist()
    return c.json({ graph: toProvJsonLd(graph) })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

/** 会話に表示名を付ける。最初の指示は書き換えない（D-008） */
app.post('/api/session/title', async (c) => {
  const body = (await c.req.json()) as { root?: string; title?: string }
  try {
    graph.assertTitle({
      root: String(body.root ?? ''),
      title: String(body.title ?? ''),
      at: new Date().toISOString(),
      agents: [(await personAgent()).id],
    })
    await persist()
    return c.json({ graph: toProvJsonLd(graph) })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

/** 会話をまるごと消す。画像のファイルも消す */
app.delete('/api/session', async (c) => {
  const body = (await c.req.json()) as { root?: string }
  try {
    const { removedImages, removedConditioningImages, removedMaskImages } = graph.deleteSession(
      String(body.root ?? ''),
    )
    for (const location of [...removedImages, ...removedConditioningImages, ...removedMaskImages]) {
      const name = location.split('/').pop()
      // ファイル名しか使わない。data の外は触らない
      if (name && /^[0-9a-f]{8,64}\.png$/.test(name)) {
        await rm(join(IMAGE_DIR, name), { force: true })
      }
    }
    await persist()
    return c.json({
      graph: toProvJsonLd(graph),
      removed: removedImages.length + removedConditioningImages.length + removedMaskImages.length,
    })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

/**
 * その版をもう一度出す。**「再実行できる」という主張を実際に検査する。**
 *
 * 記録どおりの prompt / model / seed / steps / サイズで走らせ、
 * 出てきた絵の内容ハッシュが元と一致するかを見る。
 * 一致すれば同じ Entity に生成が 1 本増える（再現できた証拠が残る）。
 * 食い違えば別の Entity ができる——そのことも隠さず記録する。
 */
app.post('/api/rerun', async (c) => {
  const body = (await c.req.json()) as { entity?: string }
  const target = String(body.entity ?? '')
  const original = graph.activityThatGenerated(target)
  if (!original) return c.json({ error: `その版がグラフに無い: ${target}` }, 400)

  try {
    const result = await serial(async () => {
      const parentSource =
        original.used.length > 0 ? sourceImageOf(original.used[0]!) : undefined
      const mask =
        original.maskImageLocation && original.maskImageDigest
          ? imageFileOf(original.maskImageLocation, original.maskImageDigest)
          : undefined
      const generationSource = original.conditioningImageLocation
        ? imageFileOf(
            original.conditioningImageLocation,
            original.conditioningImageDigest ?? '',
          )
        : parentSource
      if (mask && !parentSource) {
        throw new Error('inpaintingの再実行に必要な親画像が記録されていません')
      }
      const tool = (original.selectedTool ??
        (mask ? 'image.erase' : parentSource ? 'image.edit' : 'image.generate')) as ImageToolName
      // 再実行も新しい版を生む＝系譜に辺が 1 本増える。禁じているなら、ここも通さない
      if ((await readPolicy()).forbidSynthesis && imageToolPixelOrigin(tool) === 'synthesized') {
        throw new SynthesisForbiddenError(
          'この版は画素を作る操作で作られています。いまの設定では出し直せません',
        )
      }
      const plan = validateImagePlan(
        {
          tool,
          arguments: original.toolArguments ? JSON.parse(original.toolArguments) : {},
        },
        { hasSourceImage: Boolean(parentSource), hasEditRegion: Boolean(mask) },
      )
      let generated: GenerateResult
      if (tool === 'image.erase' && mask && parentSource) {
        generated = await inpaintImage({
          imagePath: parentSource.path,
          imageDigest: parentSource.digest,
          maskPath: mask.path,
          maskDigest: mask.digest,
        })
      } else if (parentSource && isStandardTool(tool)) {
        generated = await processStandardImage({
          tool,
          arguments: plan.arguments,
          imagePath: parentSource.path,
          imageDigest: parentSource.digest,
        })
      } else if (tool === 'background.remove' && parentSource) {
        generated = await removeBackground({
          imagePath: parentSource.path,
          imageDigest: parentSource.digest,
          command: resolveBackgroundRemovalCommand(),
        })
      } else {
        generated = await generateImage({
          prompt: original.prompt,
          seed: original.seed,
          // 記録されたモデルで走らせる。ここを足元の既定に任せると、既定を
          // 差し替えた瞬間に過去の版が軒並み「食い違った」と記録される——
          // 原因は元の生成ではなくこちらの差し替えなので、誤った結論が残る（D-002）
          model: original.model,
          ...(original.width !== undefined ? { width: original.width } : {}),
          ...(original.height !== undefined ? { height: original.height } : {}),
          ...(original.steps !== undefined ? { steps: original.steps } : {}),
          ...(tool === 'image.edit' && generationSource
            ? {
                imagePath: generationSource.path,
                imageDigest: generationSource.digest,
                imageStrength: original.imageStrength ?? IMAGE_EDIT_STRENGTH,
              }
            : {}),
        })
      }
      const digest = imageContentDigest(generated.png)
      const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
      await writeFile(path, generated.png)
      const dimensions = pngDimensions(generated.png)

      const match = digest === graph.getEntity(target)?.digest
      const entity = graph.recordGeneration({
        image: { digest },
        label: match ? original.label : `${original.label}（再実行で食い違った）`,
        location: `images/${digest.slice(0, 16)}.png`,
        prompt: original.prompt,
        model: generated.model,
        provider: generated.provider,
        seed: original.seed,
        ...(original.steps !== undefined ? { steps: original.steps } : {}),
        ...(dimensions ??
          (original.width !== undefined && original.height !== undefined
            ? { width: original.width, height: original.height }
            : {})),
        ...(tool === 'image.edit' && generationSource
          ? { imageStrength: original.imageStrength ?? IMAGE_EDIT_STRENGTH }
          : {}),
        ...(original.conditioningImageDigest && original.conditioningImageLocation
          ? {
              conditioningImageDigest: original.conditioningImageDigest,
              conditioningImageLocation: original.conditioningImageLocation,
            }
          : {}),
        ...(original.maskImageDigest && original.maskImageLocation
          ? {
              maskImageDigest: original.maskImageDigest,
              maskImageLocation: original.maskImageLocation,
            }
          : {}),
        ...(original.planningMode ? { planningMode: original.planningMode } : {}),
        ...(original.plannerProvider ? { plannerProvider: original.plannerProvider } : {}),
        ...(original.plannerModel ? { plannerModel: original.plannerModel } : {}),
        selectedTool: tool,
        reproducibility: imageToolReproducibility(tool),
        pixelOrigin: imageToolPixelOrigin(tool),
        ...(commandTemplateOf(tool, generationSource !== undefined, RESOLVERS)
          ? { commandTemplate: commandTemplateOf(tool, generationSource !== undefined, RESOLVERS)! }
          : {}),
        toolArguments: JSON.stringify(plan.arguments),
        startedAtTime: generated.startedAtTime,
        endedAtTime: generated.endedAtTime,
        intent: match ? '再実行（一致）' : '再実行（食い違い）',
        ...(original.used.length > 0 ? { derivedFrom: original.used } : {}),
        // 前の絵を材料にしたわけではないので派生ではない。同じものを指す別の実体
        ...(match ? {} : { alternateOf: target }),
        ...(original.referenced.length > 0 ? { referenced: original.referenced } : {}),
        agents: [executorAgent(tool).id, (await personAgent()).id],
      })
      await persist()
      return { match, entity }
    })

    return c.json({ ...result, graph: toProvJsonLd(graph) })
  } catch (error) {
    // 設定と指示の組み合わせの問題であって、サーバの故障ではない
    if (error instanceof SynthesisForbiddenError) return c.json({ error: error.message }, 400)
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

/**
 * 外から持ち込んだ画像を取り込む（D-019）。
 *
 * Activity を伴わせるのが肝。Entity だけ置くと、会話の根が「親を持たない生成が
 * 生んだ画像」で定義されている以上（`ProvGraph.roots`）画面に出てこないうえ、
 * **いつ・誰が持ち込んだかという実在する事実の置き場所が無くなる。**
 */
app.post('/api/import', async (c) => {
  const body = (await c.req.json()) as { dataUrl?: string; fileName?: string }
  try {
    const imported = await importImage(decodeImageDataUrl(String(body.dataUrl ?? '')))
    const fileName = baseFileName(String(body.fileName ?? '')) || '取り込んだ画像'

    const entity = await serial(async () => {
      const digest = imageContentDigest(imported.png)
      const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
      await writeFile(path, imported.png)
      const dimensions = pngDimensions(imported.png)
      const now = new Date().toISOString()
      const recorded = graph.recordGeneration({
        image: { digest },
        label: fileName,
        location: `images/${digest.slice(0, 16)}.png`,
        // モデルへ渡した文字列は無い。再現に要るのは元のファイルで、
        // それは sourceFileDigest が持つ（D-019）
        prompt: '取り込み',
        model: 'import',
        seed: 0,
        ...(dimensions ?? {}),
        intent: `取り込み: ${fileName}`,
        selectedTool: 'image.import',
        reproducibility: imageToolReproducibility('image.import'),
        pixelOrigin: imageToolPixelOrigin('image.import'),
        sourceFileDigest: imported.sourceFileDigest,
        sourceFileMediaType: imported.sourceFileMediaType,
        sourceFileName: fileName,
        startedAtTime: now,
        endedAtTime: now,
        agents: [
          // PNG はそのまま通すので、そのときは Jimp が走っていない。
          // 走ったものだけ載せる（D-015）
          ...(imported.converted ? [standardTool.id] : []),
          (await personAgent()).id,
        ],
      })
      await persist()
      return recorded
    })

    return c.json({ entity, graph: toProvJsonLd(graph) })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 400)
  }
})

app.post('/api/generate', async (c) => {
  const body = (await c.req.json()) as GenerateBody
  if (!body.intent?.trim() && !body.prompt?.trim()) {
    return c.json({ error: '指示が空です' }, 400)
  }

  const parentActivity = body.parent ? graph.activityThatGenerated(body.parent) : undefined
  if (body.parent && !graph.getEntity(body.parent)) {
    return c.json({ error: `その版はグラフにありません: ${body.parent}` }, 400)
  }

  try {
    /**
     * 材料として足した別の画像（D-021）。**先頭は利用者が居た版**で、そこから
     * 分岐したことになる。並び順は畳むときの左右にもなる
     */
    const extraParents = [
      ...new Set((Array.isArray(body.extraParents) ? body.extraParents : []).map(String)),
    ]
      .filter((id) => id && id !== body.parent)
      .slice(0, MAX_EXTRA_SOURCES)
    if (extraParents.length > 0 && !body.parent) {
      return c.json({ error: '材料を足すには、まず版を選んでください' }, 400)
    }
    for (const id of extraParents) {
      if (!graph.getEntity(id)) return c.json({ error: `その版はグラフにありません: ${id}` }, 400)
    }
    const source = body.parent ? sourceImageOf(body.parent) : undefined
    const extraSources = extraParents.map((id) => sourceImageOf(id))

    /**
     * 画面で引いた矢印（D-020）。**位置は引数そのもの**なので、有無ではなく値を渡す。
     * どこを指すかは利用者にしか分からず、こちらでは推測しない
     */
    const percent = (value: unknown) =>
      typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 100
        ? value
        : undefined
    const arrowInput = body.arrow
      ? {
          x1: percent(body.arrow.x1),
          y1: percent(body.arrow.y1),
          x2: percent(body.arrow.x2),
          y2: percent(body.arrow.y2),
        }
      : undefined
    const arrowLabel =
      typeof body.arrow?.text === 'string' ? body.arrow.text.trim().slice(0, 40) : ''
    const arrow =
      arrowInput &&
      arrowInput.x1 !== undefined &&
      arrowInput.y1 !== undefined &&
      arrowInput.x2 !== undefined &&
      arrowInput.y2 !== undefined
        ? {
            x1: arrowInput.x1,
            y1: arrowInput.y1,
            x2: arrowInput.x2,
            y2: arrowInput.y2,
            ...(arrowLabel ? { text: arrowLabel } : {}),
          }
        : undefined
    if (body.arrow && !arrow) {
      return c.json({ error: '矢印の位置は 0〜100 の整数（％）で指定します' }, 400)
    }
    if (arrow && !source) {
      return c.json({ error: '矢印を引くには親画像が必要です' }, 400)
    }
    if ((body.maskedImage || body.maskImage) && !source) {
      return c.json({ error: '編集範囲を指定するには親画像が必要です' }, 400)
    }
    const instruction = body.intent?.trim() || body.prompt?.trim() || ''
    // 系譜のこれまでの指示（根に近い順）。製品名のような文脈は根の意図にしかない
    const lineageIntents = body.parent
      ? [
          ...new Set(
            graph
              .lineage(body.parent)
              .map((a) => (a.intent ?? a.prompt).trim())
              .filter(Boolean),
          ),
        ]
          .slice(0, 8)
          .map((t) => t.slice(0, 300))
      : []
    const planning = await planImageOperation({
      intent: instruction,
      context: {
        hasSourceImage: Boolean(source),
        hasEditRegion: Boolean(body.maskImage),
        hasExtraSources: extraSources.length > 0,
        ...(arrow ? { arrow } : {}),
        forbidSynthesis: (await readPolicy()).forbidSynthesis,
        // 画素からは分からない「この絵の作られ方」を渡す
        ...(parentActivity?.selectedTool
          ? { parentTool: parentActivity.selectedTool as ImageToolName }
          : {}),
        ...(parentActivity?.selectedTool === 'image.wordmark'
          ? { parentText: parsedToolArguments(parentActivity.toolArguments).text }
          : {}),
      },
      lineage: lineageIntents,
      planner: await plannerCredentials(CONFIG_DIR),
    })
    const plan = planning.plan
    const useInpainting = plan.tool === 'image.erase'
    const maskImage =
      useInpainting && body.maskImage ? await storePngDataUrl(body.maskImage) : undefined
    /**
     * 融合はモデルへ 1 枚しか渡せない（D-021）。材料は全部 `used` に残したまま、
     * 横に並べた 1 枚を作って渡す。**実際に渡した 1 枚は conditioningImage に残る**ので、
     * 記録から同じ絵を作り直せる（D-002）
     */
    const composed =
      plan.tool === 'image.compose' && source && extraSources.length > 0
        ? await storeComposedImage([source, ...extraSources])
        : undefined
    const conditioningImage =
      composed ??
      (plan.tool === 'image.edit'
        ? body.maskedImage
          ? await storePngDataUrl(body.maskedImage)
          : source
        : undefined)
    const inpaintInput =
      useInpainting && source && maskImage
        ? {
            imagePath: source.path,
            imageDigest: source.digest,
            maskPath: maskImage.path,
            maskDigest: maskImage.digest,
          }
        : undefined
    if (useInpainting && !inpaintInput) {
      return c.json({ error: '範囲を消去するには編集範囲のマスクが必要です' }, 400)
    }
    /**
     * ワードマークは帯を継ぎ足す。既に自分で帯を付けた版へもう一度かけると二重になり、
     * 余白を変えたいだけでも作り直せない。来歴に「この版はワードマークで作った」と
     * 残っているので、その入力画像まで戻して描き直す（D-014）。
     */
    // 戻り先の判断は来歴が持つ（同じ判断を2か所に置くと、また片方がずれる）
    const rebuildBase =
      plan.tool === 'image.wordmark' && body.parent
        ? graph.rebuildBaseOf(body.parent, 'image.wordmark')
        : undefined
    const wordmarkBase =
      rebuildBase?.location !== undefined
        ? tryImageFile(rebuildBase.location, rebuildBase.digest)
        : undefined
    const standardSource = wordmarkBase ?? source
    const standardInput =
      standardSource && isStandardTool(plan.tool)
        ? {
            tool: plan.tool,
            arguments: plan.arguments,
            imagePath: standardSource.path,
            imageDigest: standardSource.digest,
          }
        : undefined
    const backgroundInput =
      source && plan.tool === 'background.remove'
        ? {
            imagePath: source.path,
            imageDigest: source.digest,
            command: resolveBackgroundRemovalCommand(),
          }
        : undefined
    // 親画像を入力できるときは、親の全文プロンプトを次へ持ち越さない。
    // 候補を複数出すときは、ここからばらす（D-018）
    const basePrompt = useInpainting
      ? 'Inpaint the masked region using the surrounding image.'
      : plan.tool === 'image.compose'
        ? body.prompt?.trim() ||
          // 渡すのは材料を横に並べた 1 枚。そう言わないと、並んだままの絵が返る
          `${COMPOSE_HINT} ${plan.prompt ?? instruction}`
        : plan.tool === 'image.generate' || plan.tool === 'image.edit'
        ? body.prompt?.trim() ||
          promptForImageGeneration(
            parentActivity?.prompt,
            // LLMが書き直した指示があればそちらを使う。生の言葉はintentとして別に残る
            plan.prompt ?? instruction,
            Boolean(source),
            Boolean(body.maskedImage),
            plan.arguments.text,
          )
        : instruction
    const usesImageModel =
      plan.tool === 'image.generate' ||
      plan.tool === 'image.edit' ||
      plan.tool === 'image.compose'

    /**
     * 候補の数（D-018）。**画像モデルを使う手だけ**に効く。確定的なツールで枚数を
     * 増やしても同じ画素が出るだけで、同じ Entity に畳まれる（D-001）
     */
    const wantedVariants = usesImageModel
      ? Math.min(Math.max(Math.trunc(Number(body.variants ?? 1)) || 1, 1), MAX_VARIANTS)
      : 1
    const notices: string[] = []
    let variantPrompts = [basePrompt]
    if (wantedVariants > 1) {
      const planner = await plannerCredentials(CONFIG_DIR)
      if (planner?.enabled && planner.modelId.trim()) {
        try {
          variantPrompts = await proposeVariantPrompts({
            intent: instruction,
            basePrompt,
            count: wantedVariants,
            ...(plan.arguments.text ? { text: plan.arguments.text } : {}),
            lineage: lineageIntents,
            planner,
          })
        } catch (error) {
          // 方向を作れなかったのは失敗ではない。seed 違いへ落として、そう伝える
          variantPrompts = Array.from({ length: wantedVariants }, () => basePrompt)
          notices.push(
            `方向の違う案を作れなかったので、同じ指示のまま seed だけ変えた候補を出します（${
              error instanceof Error ? error.message : String(error)
            }）`,
          )
        }
      } else {
        variantPrompts = Array.from({ length: wantedVariants }, () => basePrompt)
        notices.push('指示のAI解釈が無効なので、同じ指示のまま seed だけ変えた候補を出します')
      }
    } else if (usesImageModel && asksForMultipleCandidates(instruction)) {
      // 黙って 1 枚だけ出すのが、この機能が無かったころの問題そのものだった
      notices.push(
        '複数の候補を頼まれていますが、候補の数が 1 になっています。チャット下の「候補」で数を選ぶと、まとめて出します',
      )
    }

    // 枚数ぶんまとめて決める。1 枚ずつ時刻から引くと、同じ送信の中で揃わない
    const stamp = Date.now()
    const variants = variantPrompts.map((variantPrompt, index) => ({
      prompt: variantPrompt,
      seed: usesImageModel
        ? Number.isInteger(body.seed) && variantPrompts.length === 1
          ? body.seed!
          : // 同じ指示を 2 回出しても違う絵が出るように、指示から決めた値をずらす
            Number.parseInt(sha256(`${variantPrompt}${stamp}${index}`).slice(0, 8), 16) % 2 ** 31
        : 0,
    }))

    /**
     * 候補が 2 本以上走るなら、その送信を `prov:Plan` として置く（D-022）。
     * 親が無い候補は兄弟になりようがないので、これが無いと 1 つの依頼が
     * 複数の会話に割れる。1 本だけのときは作らない——Activity の
     * `provision:intent` が同じことを言っており、足しても言えることが増えない
     */
    const sendPlan =
      variants.length > 1 ? graph.addPlan(instruction, new Date(stamp).toISOString()) : undefined

    const entities: ImageEntity[] = []
    let firstError: unknown
    for (const { prompt, seed } of variants) {
      try {
        entities.push(
          await serial(async () => {
            const key = inpaintInput
              ? inpaintCacheKeyOf(inpaintInput)
              : standardInput
                ? standardImageCacheKeyOf(standardInput)
                : backgroundInput
                  ? backgroundRemovalCacheKeyOf(backgroundInput)
                  : cacheKeyOf(
                      {
                        prompt,
                        seed,
                        ...(conditioningImage
                          ? {
                              imageDigest: conditioningImage.digest,
                              imageStrength: IMAGE_EDIT_STRENGTH,
                            }
                          : {}),
                      },
                      // キャッシュ鍵はモデルを含む。編集は別コマンド＝別モデルなので取り違えない
                      modelIdOf(conditioningImage ? resolveImageEditCommand() : resolveImageCommand()),
                    )
            const cachedPng = join(CACHE_DIR, `${key}.png`)
            const cachedMeta = join(CACHE_DIR, `${key}.json`)

            let result: GenerateResult
            if (existsSync(cachedPng) && existsSync(cachedMeta)) {
              const meta = JSON.parse(await readFile(cachedMeta, 'utf8'))
              result = { ...meta, png: new Uint8Array(await readFile(cachedPng)) }
            } else {
              result = inpaintInput
                ? await inpaintImage(inpaintInput)
                : standardInput
                  ? await processStandardImage(standardInput)
                  : backgroundInput
                    ? await removeBackground(backgroundInput)
                : await generateImage({
                    prompt,
                    seed,
                    ...(conditioningImage
                      ? {
                          imagePath: conditioningImage.path,
                          imageDigest: conditioningImage.digest,
                          imageStrength: IMAGE_EDIT_STRENGTH,
                        }
                      : {}),
                  })
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

            // 絵の内容だけを数える。PNG のファイル全体だと生成時刻で毎回変わる
            const digest = imageContentDigest(result.png)
            const path = join(IMAGE_DIR, `${digest.slice(0, 16)}.png`)
            await writeFile(path, result.png)
            const dimensions = pngDimensions(result.png)

            const recorded = graph.recordGeneration({
              image: { digest },
              label: body.label?.trim() || body.intent || '無題',
              location: `images/${digest.slice(0, 16)}.png`,
              prompt,
              model: result.model,
              provider: result.provider,
              seed,
              // 実際に使った値を記録する。mflux 側の既定と必ず同じものを指す（D-002）
              ...(usesImageModel ? { steps: DEFAULT_STEPS } : {}),
              ...(dimensions ? dimensions : {}),
              ...((plan.tool === 'image.edit' || plan.tool === 'image.compose') && source
                ? { imageStrength: IMAGE_EDIT_STRENGTH }
                : {}),
              ...((plan.tool === 'image.compose' ||
                (plan.tool === 'image.edit' && body.maskedImage)) &&
              conditioningImage
                ? {
                    conditioningImageDigest: conditioningImage.digest,
                    conditioningImageLocation: `images/${conditioningImage.digest.slice(0, 16)}.png`,
                  }
                : {}),
              // 親ではなく、その奥の版から描き直したときは、実際に使った画像を残す。
              // これが無いと、記録から同じ絵を作り直せない（D-002）
              ...(wordmarkBase
                ? {
                    conditioningImageDigest: wordmarkBase.digest,
                    conditioningImageLocation: `images/${wordmarkBase.digest.slice(0, 16)}.png`,
                  }
                : {}),
              ...(useInpainting && maskImage
                ? {
                    maskImageDigest: maskImage.digest,
                    maskImageLocation: `images/${maskImage.digest.slice(0, 16)}.png`,
                  }
                : {}),
              ...(sendPlan ? { planId: sendPlan.id } : {}),
            planningMode: planning.mode,
              ...(planning.plannerProvider ? { plannerProvider: planning.plannerProvider } : {}),
              ...(planning.plannerModel ? { plannerModel: planning.plannerModel } : {}),
              selectedTool: plan.tool,
              reproducibility: imageToolReproducibility(plan.tool),
              pixelOrigin: imageToolPixelOrigin(plan.tool),
              ...(commandTemplateOf(plan.tool, conditioningImage !== undefined, RESOLVERS)
                ? { commandTemplate: commandTemplateOf(plan.tool, conditioningImage !== undefined, RESOLVERS)! }
                : {}),
              toolArguments: JSON.stringify(plan.arguments),
              startedAtTime: result.startedAtTime,
              endedAtTime: result.endedAtTime,
              ...(body.intent?.trim() ? { intent: body.intent } : {}),
              // 材料は全部 used に入れる。会話をたどるのは利用者が居た版（D-021）
              ...(body.parent ? { derivedFrom: [body.parent, ...extraParents] } : {}),
              ...(body.parent && extraParents.length > 0 ? { branchedFrom: body.parent } : {}),
              ...(body.referenced?.length ? { referenced: body.referenced } : {}),
              agents: [
                executorAgent(plan.tool).id,
                plannerAgent(planning).id,
                (await personAgent()).id,
              ],
            })
            await persist()
            return recorded
          }),
        )
      } catch (error) {
        if (firstError === undefined) firstError = error
      }
    }
    // 全部落ちたときだけ失敗として返す。1 枚でも出ていれば、出た分は捨てない
    if (entities.length === 0) throw firstError ?? new Error('生成に失敗しました')
    if (entities.length < variants.length) {
      notices.push(`${variants.length} 枚のうち ${entities.length} 枚が出ました`)
    }

    return c.json({
      entity: entities[0],
      entities,
      graph: toProvJsonLd(graph),
      routing: {
        mode: planning.mode,
        tool: plan.tool,
        arguments: plan.arguments,
        variants: entities.length,
        ...(planning.plannerModel ? { plannerModel: planning.plannerModel } : {}),
        ...(planning.plannerProvider ? { plannerProvider: planning.plannerProvider } : {}),
        ...(planning.warning || notices.length > 0
          ? { warning: [planning.warning, ...notices].filter(Boolean).join(' / ') }
          : {}),
      },
    })
  } catch (error) {
    // 画像が変わらなかったのは利用者側の指示の問題で、サーバの故障ではない
    if (error instanceof UnchangedImageError) {
      return c.json(
        {
          error:
            'この指示では画像が変わりませんでした。同じ絵は同じ版として扱うため、新しい版は作られていません。指示を具体的にするか、別のツールが選ばれる言い方を試してください',
        },
        400,
      )
    }
    // 画素を作る操作を禁じている設定で、それしか選べない指示だった（D-020）。
    // これも利用者側の話で、サーバの故障ではない
    if (error instanceof SynthesisForbiddenError) {
      return c.json({ error: error.message }, 400)
    }
    const why = error instanceof Error ? error.message : String(error)
    return c.json({ error: why }, 500)
  }
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PROVision server: http://127.0.0.1:${info.port}  data=${DATA_DIR}`)
})
