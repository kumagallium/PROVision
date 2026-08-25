import type { AiPlannerConfig } from './config.js'
import {
  ARGUMENT_LABELS,
  imageToolDefinition,
  isImageToolName,
  toolCatalogForPrompt,
  type ImageToolArgumentName,
  type ImageToolName,
} from './tools.js'
import {
  isTextAdditionIntent,
  isTextRestyleIntent,
  isWordmarkGapIntent,
} from '../image/prompt.js'
import { resolveAiApiBase } from './provider.js'

export type { ImageToolName } from './tools.js'

export interface ImageToolArguments {
  angle?: 90 | 180 | 270
  width?: number
  height?: number
  padding?: number
  /** 描画する文字列。image.generate / image.edit だけが受け取れる */
  text?: string
}

export interface ImageOperationPlan {
  tool: ImageToolName
  arguments: ImageToolArguments
  reason: string
  /** LLMが利用者の雑な指示を画像モデル向けに書き直した全文。image.generate / image.edit のみ */
  prompt?: string
}

export interface PlannedImageOperation {
  plan: ImageOperationPlan
  mode: 'rules' | 'llm'
  plannerProvider?: string
  plannerModel?: string
  warning?: string
}

export interface PlanningContext {
  hasSourceImage: boolean
  hasEditRegion: boolean
  /**
   * 親画像を作ったツール。画素からは「帯と文字を足した絵」だとは分からないが、
   * 来歴には残っている。構造を作り直せるかどうかの判断材料として渡す（D-014）
   */
  parentTool?: ImageToolName
  /**
   * 親のワードマークが描いた文字列。作り直すときに引き継ぐ。
   * LLM は画像に何と書いてあるかを見られないので、ここが無いと落とす
   */
  parentText?: string
}

function boundedInteger(value: unknown, min: number, max: number): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    return undefined
  }
  return value
}

export function validateImagePlan(
  value: unknown,
  context: PlanningContext,
): ImageOperationPlan {
  if (!value || typeof value !== 'object') throw new Error('ツール計画がJSONオブジェクトではありません')
  const raw = value as Record<string, unknown>
  if (!isImageToolName(raw.tool)) {
    throw new Error(`未対応の画像ツールです: ${String(raw.tool)}`)
  }
  const tool = raw.tool
  const spec = imageToolDefinition(tool)
  if (spec.requiresSourceImage === 'forbidden' && context.hasSourceImage) {
    throw new Error(`編集元画像がある場合は${tool}を選べません`)
  }
  if (spec.requiresSourceImage === true && !context.hasSourceImage) {
    throw new Error(`${tool}には編集元の画像が必要です`)
  }
  if (spec.requiresEditRegion && !context.hasEditRegion) {
    throw new Error(`${tool}には利用者が指定した編集範囲が必要です`)
  }
  const sourceArgs =
    raw.arguments && typeof raw.arguments === 'object'
      ? (raw.arguments as Record<string, unknown>)
      : {}
  // 受け取れない引数は黙って落とす。弾くと計画ごと捨てて別のツールへ落ちる
  const taken = <T>(name: ImageToolArgumentName, value: T): T | undefined =>
    spec.accepts.includes(name) ? value : undefined
  const angle = taken('angle', boundedInteger(sourceArgs.angle, 90, 270))
  const width = taken('width', boundedInteger(sourceArgs.width, 1, 8192))
  const height = taken('height', boundedInteger(sourceArgs.height, 1, 8192))
  const padding = taken('padding', boundedInteger(sourceArgs.padding, 0, 1024))
  const rawText = typeof sourceArgs.text === 'string' ? sourceArgs.text.trim() : undefined
  // 作り直しでは、描く文字列を来歴から補う。画素を見られないLLMは落としがち
  const inherited =
    !rawText && tool === 'image.wordmark' && context.parentTool === 'image.wordmark'
      ? context.parentText?.trim()
      : undefined
  const text = taken('text', rawText || inherited)
  if (text && (text.length > 40 || /[\u0000-\u001f\u007f]/.test(text))) {
    throw new Error('textは制御文字を含まない40文字以内で指定します')
  }
  const present: Record<ImageToolArgumentName, unknown> = { angle, width, height, padding, text }
  for (const name of spec.requiredArguments ?? []) {
    if (present[name] === undefined) {
      throw new Error(`${tool}には${ARGUMENT_LABELS[name]}が必要です`)
    }
  }
  if (tool === 'image.rotate' && ![90, 180, 270].includes(angle ?? 0)) {
    throw new Error('image.rotateのangleは90、180、270のいずれかです')
  }
  if (tool === 'image.resize' && width === undefined && height === undefined) {
    throw new Error('image.resizeにはwidthまたはheightが必要です')
  }
  // 画像モデルを使わないツールに書き直し文が付いてくることがある。使い道がないだけで
  // 害はないので、弾かずに落とす（弾くと計画ごと捨てて生成側へ落ち、別物が描かれる）
  const rewritten =
    spec.usesPrompt && typeof raw.prompt === 'string'
      ? raw.prompt.replace(/\s+/g, ' ').trim()
      : undefined
  if (rewritten) {
    if (rewritten.length > 600 || /[\u0000-\u001f\u007f]/.test(rewritten)) {
      throw new Error('promptは制御文字を含まない600文字以内で指定します')
    }
    // 推定した文字列が書き直しで落ちると、描画対象が失われる
    if (text && !rewritten.includes(text)) {
      throw new Error('promptには推定したtextをそのまま含めます')
    }
  }
  return {
    tool,
    arguments: {
      ...(angle !== undefined ? { angle: angle as 90 | 180 | 270 } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(padding !== undefined ? { padding } : {}),
      ...(text ? { text } : {}),
    },
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '',
    ...(rewritten ? { prompt: rewritten } : {}),
  }
}

function explicitRule(intent: string, context: PlanningContext): ImageOperationPlan | undefined {
  if (!context.hasSourceImage) {
    return { tool: 'image.generate', arguments: {}, reason: '編集元画像がないため新規生成' }
  }
  if (
    context.hasEditRegion &&
    /(消|削除|除去|取り除|なく|無く|修復|補修|埋め|隠|remove|delete|erase|heal|inpaint)/i.test(
      intent,
    )
  ) {
    return { tool: 'image.erase', arguments: {}, reason: '範囲指定を伴う削除・修復指示' }
  }
  const quoted = /[「『"“']([^」』"”']{1,40})[」』"”']/.exec(intent)?.[1]?.trim()
  // 既にある文字を整える依頼は追加ではない。確定描画で重ねると二重になる
  if (quoted && isTextAdditionIntent(intent) && !isTextRestyleIntent(intent)) {
    // 拡散モデルは字形を崩す。文字列が分かっているならフォントで置く
    return {
      tool: 'image.wordmark',
      arguments: { text: quoted },
      reason: '描く文字列が明示された文字追加の指示',
    }
  }
  if (/(背景).*(透明|透過)|(透明|透過).*(背景)|remove\s+background/i.test(intent)) {
    return { tool: 'background.remove', arguments: {}, reason: '背景透明化の明示指示' }
  }
  const rotate =
    /(?:回転|rotate)[^\d]*(90|180|270)/i.exec(intent) ??
    /(90|180|270)\s*度?[^\d]*(?:回転|rotate)/i.exec(intent)
  if (rotate) {
    return {
      tool: 'image.rotate',
      arguments: { angle: Number(rotate[1]) as 90 | 180 | 270 },
      reason: '回転角度の明示指示',
    }
  }
  const dimensions = /(\d{1,4})\s*[x×]\s*(\d{1,4})/i.exec(intent)
  const widthOnly = /(?:幅|width)\s*[:：]?\s*(\d{1,4})/i.exec(intent)
  const heightOnly = /(?:高さ|height)\s*[:：]?\s*(\d{1,4})/i.exec(intent)
  if (/(リサイズ|サイズ変更|resize)/i.test(intent) || dimensions || widthOnly || heightOnly) {
    const width = dimensions ? Number(dimensions[1]) : widthOnly ? Number(widthOnly[1]) : undefined
    const height = dimensions ? Number(dimensions[2]) : heightOnly ? Number(heightOnly[1]) : undefined
    if (width !== undefined || height !== undefined) {
      return { tool: 'image.resize', arguments: { width, height }, reason: '画像寸法の明示指示' }
    }
  }
  if (/(正方形|square).*(切|トリミング|crop)|(切|トリミング|crop).*(正方形|square)/i.test(intent)) {
    return { tool: 'image.crop-square', arguments: {}, reason: '正方形への切り抜き指示' }
  }
  // 「ロゴタイプの余白」は外周ではなく要素の間。trimでは扱えないのでLLMへ預ける
  if (
    !isWordmarkGapIntent(intent) &&
    /(余白).*(整|均一|詰|削)|(トリミング|trim|crop)/i.test(intent)
  ) {
    return { tool: 'image.trim', arguments: { padding: 24 }, reason: '余白整理の指示' }
  }
  return undefined
}

/**
 * 規則ベースでは、既にワードマークがあるかを知らない（画素を見ないため）。
 * 「絵と文字の間の余白」は帯の作り直しで解けるが、確定させるには
 * 親がワードマーク由来かを知る必要があるので、ここでは決めずLLMへ預ける。
 */
export function isWordmarkGapRequest(intent: string): boolean {
  return isWordmarkGapIntent(intent)
}

export function ruleBasedPlan(
  intent: string,
  context: PlanningContext,
): ImageOperationPlan {
  return validateImagePlan(
    explicitRule(intent, context) ?? {
      tool: context.hasSourceImage ? 'image.edit' : 'image.generate',
      arguments: {},
      reason: context.hasSourceImage ? '既存画像への一般編集' : '新規画像生成',
    },
    context,
  )
}

/**
 * 推論モデルは本文の前に思考でトークンを使う。300では思考だけで打ち切られ、
 * 本文が空のまま返る（gpt-oss-120bで実測: finish_reason=length、content 0文字）。
 */
const PLANNER_MAX_TOKENS = 2000

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!candidate.trim()) {
    // 何が返ったか分からないと直せない。空応答と非JSON応答は原因が違う
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 120)
    throw new Error(
      head ? `LLMがJSONを返しませんでした: ${head}` : 'LLMが空の応答を返しました',
    )
  }
  return JSON.parse(candidate)
}

async function callPlanner(
  config: AiPlannerConfig & { apiKey: string },
  prompt: string,
  requestSignal?: AbortSignal,
): Promise<string> {
  const base = resolveAiApiBase(config)
  const timeout = AbortSignal.timeout(30_000)
  const signal = requestSignal ? AbortSignal.any([requestSignal, timeout]) : timeout
  if (config.provider === 'anthropic') {
    if (!config.apiKey) throw new Error('Anthropic APIキーが設定されていません')
    const anthropicBase = base.endsWith('/v1') ? base : `${base}/v1`
    const response = await fetch(`${anthropicBase}/messages`, {
      method: 'POST',
      signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.modelId,
        max_tokens: PLANNER_MAX_TOKENS,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
    })
    if (!response.ok) throw new Error(`Anthropic APIが失敗しました（${response.status}）`)
    const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> }
    return body.content?.find((part) => part.type === 'text')?.text ?? ''
  }
  if (config.provider === 'google') {
    if (!config.apiKey) throw new Error('Google APIキーが設定されていません')
    const response = await fetch(
      `${base}/v1beta/models/${encodeURIComponent(config.modelId)}:generateContent?key=${encodeURIComponent(config.apiKey)}`,
      {
        method: 'POST',
        signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          generationConfig: { temperature: 0, maxOutputTokens: PLANNER_MAX_TOKENS },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      },
    )
    if (!response.ok) throw new Error(`Google APIが失敗しました（${response.status}）`)
    const body = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? ''
  }

  if (config.provider === 'openai' && !config.apiKey) {
    throw new Error('OpenAI APIキーが設定されていません')
  }
  const response = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.modelId,
      temperature: 0,
      max_tokens: PLANNER_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  })
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('APIキーが無効か未設定です。設定のAIタブで入れ直してください')
    }
    throw new Error(`OpenAI互換APIが失敗しました（${response.status}）`)
  }
  const body = (await response.json()) as {
    choices?: Array<{
      finish_reason?: string
      message?: { content?: string; reasoning_content?: string }
    }>
  }
  const choice = body.choices?.[0]
  const content = choice?.message?.content ?? ''
  if (!content && choice?.finish_reason === 'length') {
    throw new Error('LLMの応答が上限で切れました。推論の短いモデルを選んでください')
  }
  // 思考側にだけJSONを入れて返すモデルがある
  return content || (choice?.message?.reasoning_content ?? '')
}

export async function planImageOperation(input: {
  intent: string
  context: PlanningContext
  /** 系譜のこれまでの指示（根に近い順）。製品名などの文脈推定に使う */
  lineage?: string[]
  planner?: AiPlannerConfig & { apiKey: string }
  signal?: AbortSignal
}): Promise<PlannedImageOperation> {
  const deterministic = explicitRule(input.intent, input.context)
  if (deterministic) {
    return { plan: validateImagePlan(deterministic, input.context), mode: 'rules' }
  }
  const fallback = ruleBasedPlan(input.intent, input.context)
  const planner = input.planner
  if (!planner?.enabled || !planner.modelId.trim()) return { plan: fallback, mode: 'rules' }

  const prompt = [
    'You route one image request to exactly one allowed tool.',
    'Return JSON only: {"tool":"...", "arguments":{}, "reason":"short reason", "prompt":"optional rewritten instruction"}.',
    'Allowed tools:',
    // 一覧は定義から組み立てる。ツールを足したときの書き漏れを構造で防ぐ
    toolCatalogForPrompt(),
    'When the user asks to add lettering (wordmark/logotype), set arguments.text to the exact string (<=40 chars). Take it from the instruction, or from the lineage when the instruction does not name it. Omit arguments.text when no name is available anywhere.',
    'Context.parentTool is the tool that produced the current picture, and Context.parentText is the lettering it drew. When parentTool is image.wordmark and the user wants to change the gap, margin, or spacing around that lettering, choose image.wordmark again: set arguments.text to Context.parentText and arguments.padding in pixels (roughly 8 for tight, 24 for default, 60 for airy). The band is rebuilt from the artwork underneath, so nothing is lost. Do not use image.edit for that — the diffusion model repaints everything and drops the lettering.',
    'For image.generate and image.edit you may set "prompt": rewrite the user instruction into one concise English instruction for the image model.',
    'Rewrite faithfully: translate, resolve ambiguity using the lineage, keep every user constraint. Do not invent styles, moods, or elements the user did not request. Max 2 sentences.',
    'If arguments.text is set, the rewritten prompt must contain that exact string.',
    `Context: ${JSON.stringify(input.context)}`,
    ...(input.lineage?.length
      ? [`Prior instructions in this lineage (oldest first): ${JSON.stringify(input.lineage)}`]
      : []),
    `User instruction: ${JSON.stringify(input.intent)}`,
  ].join('\n')

  try {
    const raw = await callPlanner(planner, prompt, input.signal)
    return {
      plan: validateImagePlan(extractJson(raw), input.context),
      mode: 'llm',
      plannerProvider: planner.provider,
      plannerModel: planner.modelId,
    }
  } catch (error) {
    return {
      plan: fallback,
      mode: 'rules',
      plannerProvider: planner.provider,
      plannerModel: planner.modelId,
      warning: `指示のAI解釈に失敗したため規則ベースで実行します: ${
        error instanceof Error ? error.message : String(error)
      }`,
    }
  }
}
