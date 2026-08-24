import type { AiPlannerConfig } from './config.js'
import { resolveAiApiBase } from './provider.js'

export type ImageToolName =
  | 'image.generate'
  | 'image.edit'
  | 'image.erase'
  | 'image.trim'
  | 'image.crop-square'
  | 'image.rotate'
  | 'image.resize'
  | 'background.remove'

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
}

const TOOL_NAMES = new Set<ImageToolName>([
  'image.generate',
  'image.edit',
  'image.erase',
  'image.trim',
  'image.crop-square',
  'image.rotate',
  'image.resize',
  'background.remove',
])

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
  if (typeof raw.tool !== 'string' || !TOOL_NAMES.has(raw.tool as ImageToolName)) {
    throw new Error(`未対応の画像ツールです: ${String(raw.tool)}`)
  }
  const tool = raw.tool as ImageToolName
  if (!context.hasSourceImage && tool !== 'image.generate') {
    throw new Error(`${tool}には編集元の画像が必要です`)
  }
  if (context.hasSourceImage && tool === 'image.generate') {
    throw new Error('編集元画像がある場合はimage.generateを選べません')
  }
  if (tool === 'image.erase' && !context.hasEditRegion) {
    throw new Error('image.eraseには利用者が指定した編集範囲が必要です')
  }
  const sourceArgs =
    raw.arguments && typeof raw.arguments === 'object'
      ? (raw.arguments as Record<string, unknown>)
      : {}
  const angle = boundedInteger(sourceArgs.angle, 90, 270)
  const width = boundedInteger(sourceArgs.width, 1, 8192)
  const height = boundedInteger(sourceArgs.height, 1, 8192)
  const padding = boundedInteger(sourceArgs.padding, 0, 1024)
  const text = typeof sourceArgs.text === 'string' ? sourceArgs.text.trim() : undefined
  if (text) {
    if (tool !== 'image.generate' && tool !== 'image.edit') {
      throw new Error(`${tool}はtext引数を受け取れません`)
    }
    if (text.length > 40 || /[\u0000-\u001f\u007f]/.test(text)) {
      throw new Error('textは制御文字を含まない40文字以内で指定します')
    }
  }
  if (tool === 'image.rotate' && ![90, 180, 270].includes(angle ?? 0)) {
    throw new Error('image.rotateのangleは90、180、270のいずれかです')
  }
  if (tool === 'image.resize' && width === undefined && height === undefined) {
    throw new Error('image.resizeにはwidthまたはheightが必要です')
  }
  const rewritten =
    typeof raw.prompt === 'string' ? raw.prompt.replace(/\s+/g, ' ').trim() : undefined
  if (rewritten) {
    if (tool !== 'image.generate' && tool !== 'image.edit') {
      throw new Error(`${tool}はprompt引数を受け取れません`)
    }
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
  if (/(余白).*(整|均一|詰|削)|(トリミング|trim|crop)/i.test(intent)) {
    return { tool: 'image.trim', arguments: { padding: 24 }, reason: '余白整理の指示' }
  }
  return undefined
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

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)?.[1]
  const candidate = fenced ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  if (!candidate.trim()) throw new Error('LLMがツール計画のJSONを返しませんでした')
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
        max_tokens: 300,
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
          generationConfig: { temperature: 0, maxOutputTokens: 300 },
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
      max_tokens: 300,
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
    choices?: Array<{ message?: { content?: string } }>
  }
  return body.choices?.[0]?.message?.content ?? ''
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
    '- image.generate: create a new image when no source exists',
    '- image.edit: generative change to an existing image; when the user asks to add lettering (wordmark/logotype) and the exact name is clear from the instruction or the lineage, set arguments.text to that exact string (<=40 chars); if no name is available anywhere, omit arguments.text',
    '- image.erase: erase/heal a user-selected region; requires hasEditRegion=true',
    '- image.trim: remove or equalize surrounding margins',
    '- image.crop-square: center-crop to a square',
    '- image.rotate: rotate; arguments.angle must be 90, 180, or 270',
    '- image.resize: resize; arguments.width/height are pixels',
    '- background.remove: make the background transparent',
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
