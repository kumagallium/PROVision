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
import { ProvGraph } from '../prov/graph.js'
import { loadGraph, saveGraph } from '../prov/store.js'
import { toNTriplesText } from '../prov/ntriples.js'
import { sha256 } from '../prov/sha256.js'
import { toProvJsonLd } from '../prov/jsonld.js'
import {
  cacheKeyOf,
  generateImage,
  modelIdOf,
  resolveImageCommand,
  type GenerateResult,
} from '../image/mflux.js'
import { imageContentDigest, pngDimensions } from '../image/png.js'
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
import {
  planImageOperation,
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
const IMAGE_DIR = join(DATA_DIR, 'images')
const CACHE_DIR = join(DATA_DIR, 'cache')
const GRAPH_PATH = join(DATA_DIR, 'lineage.jsonld')
const PORT = Number(process.env.PROVISION_PORT ?? 8788)
const IMAGE_EDIT_STRENGTH = 0.3
const MAX_CONDITIONING_IMAGE_BYTES = 12 * 1024 * 1024

await mkdir(IMAGE_DIR, { recursive: true })
await mkdir(CACHE_DIR, { recursive: true })

let graph: ProvGraph = existsSync(GRAPH_PATH)
  ? await loadGraph(GRAPH_PATH)
  : new ProvGraph()

const imageTool = graph.addAgent('mflux', 'mflux (z-image-turbo-4bit)')
const inpaintTool = graph.addAgent('lama', 'LaMa via IOPaint')
const standardTool = graph.addAgent('jimp', 'Jimp standard image processing')
const backgroundTool = graph.addAgent('rembg', 'rembg (U²-Net)')
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

const IDENTITY_PATH = join(DATA_DIR, 'identity.json')

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

function sourceImageOf(entityId: string): SourceImage {
  const entity = graph.getEntity(entityId)
  if (!entity?.location) {
    throw new Error(`親画像のファイル場所が記録されていない: ${entityId}`)
  }
  return imageFileOf(entity.location, entity.digest)
}

function isStandardTool(tool: ImageToolName): tool is StandardImageInput['tool'] {
  return ['image.trim', 'image.crop-square', 'image.rotate', 'image.resize'].includes(tool)
}

function executorAgent(tool: ImageToolName) {
  if (tool === 'image.erase') return inpaintTool
  if (tool === 'background.remove') return backgroundTool
  if (isStandardTool(tool)) return standardTool
  return imageTool
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
    return c.json(await publicAiModelRegistry(DATA_DIR))
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
  }
})

app.put('/api/ai/planner', async (c) => {
  try {
    return c.json(await updateAiModelSelection(DATA_DIR, await c.req.json()))
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
      await registerAiModel(DATA_DIR, {
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
    return c.json(await removeAiModel(DATA_DIR, c.req.param('id')))
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
    const saved = await modelCredentials(DATA_DIR, reuseModelId)
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
}

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
    return c.json({ error: error instanceof Error ? error.message : String(error) }, 500)
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
    const source = body.parent ? sourceImageOf(body.parent) : undefined
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
      },
      lineage: lineageIntents,
      planner: await plannerCredentials(DATA_DIR),
    })
    const plan = planning.plan
    const useInpainting = plan.tool === 'image.erase'
    const maskImage =
      useInpainting && body.maskImage ? await storePngDataUrl(body.maskImage) : undefined
    const conditioningImage =
      plan.tool === 'image.edit'
        ? body.maskedImage
          ? await storePngDataUrl(body.maskedImage)
          : source
        : undefined
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
    const standardInput =
      source && isStandardTool(plan.tool)
        ? {
            tool: plan.tool,
            arguments: plan.arguments,
            imagePath: source.path,
            imageDigest: source.digest,
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
    const prompt = useInpainting
      ? 'Inpaint the masked region using the surrounding image.'
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
    const usesImageModel = plan.tool === 'image.generate' || plan.tool === 'image.edit'
    const seed = usesImageModel
      ? Number.isInteger(body.seed)
        ? body.seed!
        : // 同じ指示を 2 回出しても違う絵が出るように、指示から決めた値をずらす
          Number.parseInt(sha256(`${prompt}${Date.now()}`).slice(0, 8), 16) % 2 ** 31
      : 0

    const entity = await serial(async () => {
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
                modelIdOf(resolveImageCommand()),
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
        ...(usesImageModel ? { steps: 8 } : {}),
        ...(dimensions ? dimensions : {}),
        ...(plan.tool === 'image.edit' && source
          ? { imageStrength: IMAGE_EDIT_STRENGTH }
          : {}),
        ...(plan.tool === 'image.edit' && body.maskedImage && conditioningImage
          ? {
              conditioningImageDigest: conditioningImage.digest,
              conditioningImageLocation: `images/${conditioningImage.digest.slice(0, 16)}.png`,
            }
          : {}),
        ...(useInpainting && maskImage
          ? {
              maskImageDigest: maskImage.digest,
              maskImageLocation: `images/${maskImage.digest.slice(0, 16)}.png`,
            }
          : {}),
        planningMode: planning.mode,
        ...(planning.plannerProvider ? { plannerProvider: planning.plannerProvider } : {}),
        ...(planning.plannerModel ? { plannerModel: planning.plannerModel } : {}),
        selectedTool: plan.tool,
        toolArguments: JSON.stringify(plan.arguments),
        startedAtTime: result.startedAtTime,
        endedAtTime: result.endedAtTime,
        ...(body.intent?.trim() ? { intent: body.intent } : {}),
        ...(body.parent ? { derivedFrom: [body.parent] } : {}),
        ...(body.referenced?.length ? { referenced: body.referenced } : {}),
        agents: [
          executorAgent(plan.tool).id,
          plannerAgent(planning).id,
          (await personAgent()).id,
        ],
      })
      await persist()
      return recorded
    })

    return c.json({
      entity,
      graph: toProvJsonLd(graph),
      routing: {
        mode: planning.mode,
        tool: plan.tool,
        arguments: plan.arguments,
        ...(planning.plannerModel ? { plannerModel: planning.plannerModel } : {}),
        ...(planning.plannerProvider ? { plannerProvider: planning.plannerProvider } : {}),
        ...(planning.warning ? { warning: planning.warning } : {}),
      },
    })
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return c.json({ error: why }, 500)
  }
})

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`PROVision server: http://127.0.0.1:${info.port}  data=${DATA_DIR}`)
})
