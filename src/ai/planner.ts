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
  isWholeImageIntent,
  isWordmarkGapIntent,
  type EditScope,
} from '../image/prompt.js'
import { resolveAiApiBase } from './provider.js'

export type { ImageToolName } from './tools.js'

export interface ImageToolArguments {
  angle?: 90 | 180 | 270
  width?: number
  height?: number
  padding?: number
  /** 画像全体にかける変化量（％）。**0 が無変換**。image.brightness / image.contrast */
  amount?: number
  /** 矢印の位置。**画像の大きさに対する％**なので、寸法が変わっても同じ所を指す */
  x1?: number
  y1?: number
  x2?: number
  y2?: number
  /** 描画する文字列。image.generate / image.edit だけが受け取れる */
  text?: string
}

export interface ImageOperationPlan {
  tool: ImageToolName
  arguments: ImageToolArguments
  reason: string
  /** LLMが利用者の雑な指示を画像モデル向けに書き直した全文。image.generate / image.edit のみ */
  prompt?: string
  /**
   * 一部を直すのか、全体を作り替えるのか（D-023）。**保存を求める文を出すかどうかが変わる**。
   * 作り替えの依頼へ保存を求めると自己矛盾し、絵がほとんど変わらない
   */
  scope?: EditScope
}

export interface PlannedImageOperation {
  plan: ImageOperationPlan
  mode: 'rules' | 'llm'
  plannerProvider?: string
  plannerModel?: string
  warning?: string
}

/**
 * 画素を作る操作が禁じられている設定で、それしか選べない指示が来た（D-020）。
 *
 * 別の型にしてあるのは**サーバの故障ではないから**。利用者の設定と指示の
 * 組み合わせの問題なので、500 ではなく理由を添えた 400 で返す。
 */
export class SynthesisForbiddenError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SynthesisForbiddenError'
  }
}

export interface PlanningContext {
  hasSourceImage: boolean
  hasEditRegion: boolean
  /** 材料として別の画像を足したか（D-021）。足したなら融合しかない */
  hasExtraSources?: boolean
  /**
   * 画面で引いた矢印（D-020）。**位置は画像の大きさに対する％**。
   * 引数そのものなので、有無ではなく値ごと渡す——どこを指すかは推測できない
   */
  arrow?: { x1: number; y1: number; x2: number; y2: number; text?: string }
  /**
   * 画素を作る操作（`pixelOrigin: 'synthesized'`）を禁じるか（D-020）。
   * **実行してからではなく、計画の段階で拒む**——実行時に止めると、
   * 選ばれた理由だけが画面に出て絵が出ない、という分かりにくい壊れ方をする
   */
  forbidSynthesis?: boolean
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

/**
 * 清書の上限（D-026）。600 字では、曖昧な様式語を視覚属性まで開くと切れる。
 * 青天井にしないのは、拡散モデルの注意が薄まると変更命令まで効かなくなるため
 */
export const MAX_REWRITTEN_PROMPT_LENGTH = 900

/**
 * 清書に日本語が残っているか（D-026）。**訳し漏れは清書の失敗として扱う。**
 *
 * flux2 の符号化器は日本語の指示をほとんど汲めない。そのまま渡すと「元の絵を
 * 少しいじっただけ」の版が返る（実測: 「弓矢を無くして」がそのまま渡り、弓矢が残った）
 */
export function needsTranslation(prompt: string, renderText?: string): boolean {
  // 描く文字列そのものは訳してはいけない。日本語のワードマークなら日本語で残る
  const body = renderText ? prompt.split(renderText).join(' ') : prompt
  return /[\u3040-\u30ff\u3400-\u9fff]/.test(body)
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
  // 取り込みのように、画面のファイル操作からしか起きないツール（D-019）。
  // 「取り込んで」と言われても渡すファイルが無いので、計画の段階で拒む
  if (spec.selectableByInstruction === false) {
    throw new Error(`${tool}は指示からは選べません`)
  }
  if (spec.requiresSourceImage === 'forbidden' && context.hasSourceImage) {
    throw new Error(`編集元画像がある場合は${tool}を選べません`)
  }
  if (spec.requiresSourceImage === true && !context.hasSourceImage) {
    throw new Error(`${tool}には編集元の画像が必要です`)
  }
  if (spec.requiresEditRegion && !context.hasEditRegion) {
    throw new Error(`${tool}には利用者が指定した編集範囲が必要です`)
  }
  if (spec.requiresExtraSources && !context.hasExtraSources) {
    throw new Error(`${tool}には材料として足した別の画像が必要です`)
  }
  if (context.forbidSynthesis && spec.pixelOrigin === 'synthesized') {
    throw new SynthesisForbiddenError(
      `${tool}は入力に無かった画素を作る操作なので、いまの設定では実行できません`,
    )
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
  const amount = taken('amount', boundedInteger(sourceArgs.amount, -100, 300))
  // 矢印の位置は画像の大きさに対する％。寸法に依らないので、後から縮めても指す所が変わらない
  const x1 = taken('x1', boundedInteger(sourceArgs.x1, 0, 100))
  const y1 = taken('y1', boundedInteger(sourceArgs.y1, 0, 100))
  const x2 = taken('x2', boundedInteger(sourceArgs.x2, 0, 100))
  const y2 = taken('y2', boundedInteger(sourceArgs.y2, 0, 100))
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
  const present: Record<ImageToolArgumentName, unknown> = {
    angle,
    width,
    height,
    padding,
    text,
    amount,
    x1,
    y1,
    x2,
    y2,
  }
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
  // コントラストは -100〜100。明るさだけ 300% まで上げられる
  if (tool === 'image.contrast' && (amount === undefined || amount < -100 || amount > 100)) {
    throw new Error('image.contrastのamountは-100から100の整数です')
  }
  if (tool === 'image.arrow' && x1 === x2 && y1 === y2) {
    throw new Error('image.arrowは始点と終点が同じでは描けません')
  }
  // 画像モデルを使わないツールに書き直し文が付いてくることがある。使い道がないだけで
  // 害はないので、弾かずに落とす（弾くと計画ごと捨てて生成側へ落ち、別物が描かれる）
  const rewritten =
    spec.usesPrompt && typeof raw.prompt === 'string'
      ? raw.prompt.replace(/\s+/g, ' ').trim()
      : undefined
  if (rewritten) {
    if (
      rewritten.length > MAX_REWRITTEN_PROMPT_LENGTH ||
      /[\u0000-\u001f\u007f]/.test(rewritten)
    ) {
      throw new Error(
        `promptは制御文字を含まない${MAX_REWRITTEN_PROMPT_LENGTH}文字以内で指定します`,
      )
    }
    // 推定した文字列が書き直しで落ちると、描画対象が失われる
    if (text && !rewritten.includes(text)) {
      throw new Error('promptには推定したtextをそのまま含めます')
    }
  }
  /**
   * 全体を作り替える依頼か（D-023）。LLM が答えていればそれを使い、
   * 答えていなければ指示の言葉から当てる。**判断は指示を読んだ側のほうが確か**
   */
  const scope: EditScope | undefined = spec.usesPrompt
    ? raw.scope === 'whole' || raw.scope === 'local'
      ? raw.scope
      : undefined
    : undefined
  return {
    tool,
    arguments: {
      ...(angle !== undefined ? { angle: angle as 90 | 180 | 270 } : {}),
      ...(width !== undefined ? { width } : {}),
      ...(height !== undefined ? { height } : {}),
      ...(padding !== undefined ? { padding } : {}),
      ...(text ? { text } : {}),
      ...(amount !== undefined ? { amount } : {}),
      ...(x1 !== undefined ? { x1 } : {}),
      ...(y1 !== undefined ? { y1 } : {}),
      ...(x2 !== undefined ? { x2 } : {}),
      ...(y2 !== undefined ? { y2 } : {}),
    },
    reason: typeof raw.reason === 'string' ? raw.reason.slice(0, 500) : '',
    ...(rewritten ? { prompt: rewritten } : {}),
    ...(scope ? { scope } : {}),
  }
}

/**
 * 実際に使う編集の範囲（D-023）。
 *
 * **利用者の言い回しだけでなく、実際にモデルへ渡る書き直し文にも当てる。**
 * 「ベタッとしたイラストにして」は語の一致では拾えないが、書き直し文は
 * `Convert the existing rich logo into a flat, solid illustration style.` になっていた
 * （実測）。**モデルが読むのは後者**なので、そこと矛盾しないかで決めるほうが確かである。
 *
 * `local` を `whole` へ**上げることはあっても、下げることはない**。ここでやっているのは
 * 「作り替えを頼む文に、保存を求める文を並べない」ことだけで、余計な保存句を外す方向に
 * しか動かさない。
 */
export interface EditScopeDecision {
  scope: EditScope
  /** 誰が決めたか。**外したときに、どちらを直せばよいか分かる形にしておく** */
  source: 'planner' | 'rules'
}

export function editScopeOf(plan: ImageOperationPlan, intent: string): EditScopeDecision {
  if (plan.scope === 'whole') return { scope: 'whole', source: 'planner' }
  if (isWholeImageIntent(intent) || isWholeImageIntent(plan.prompt ?? '')) {
    return { scope: 'whole', source: 'rules' }
  }
  return plan.scope
    ? { scope: plan.scope, source: 'planner' }
    : { scope: 'local', source: 'rules' }
}

function explicitRule(intent: string, context: PlanningContext): ImageOperationPlan | undefined {
  if (!context.hasSourceImage) {
    return { tool: 'image.generate', arguments: {}, reason: '編集元画像がないため新規生成' }
  }
  /**
   * 矢印は画面で引いた位置がそのまま引数になる（D-020）。**位置は推測しない**——
   * どこを指すかは利用者にしか分からない。引いたなら他のツールを選ぶ余地は無い
   */
  if (context.arrow) {
    return {
      tool: 'image.arrow',
      arguments: { ...context.arrow },
      reason: '画面で引いた矢印',
    }
  }
  // 材料を足したのは画面の操作。他のツールを選ぶと、足した画像が黙って捨てられる（D-021）
  if (context.hasExtraSources) {
    return { tool: 'image.compose', arguments: {}, reason: '材料として別の画像を足した指示' }
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
  /**
   * スケールバー（D-020 の annotated）。**ワードマークより先に見る**——
   * 「入れて」は文字追加とも読めるので、後ろに置くと帯が継ぎ足される。
   * 物理的な尺度は分からないので、棒の長さも文字列も利用者が言ったものだけを使う
   */
  if (/(スケールバー|scale\s?bar)/i.test(intent)) {
    const px = /(\d{1,4})\s*(?:px|ピクセル)/i.exec(intent)
    if (quoted && px) {
      return {
        tool: 'image.scalebar',
        arguments: { text: quoted, width: Number(px[1]) },
        reason: 'スケールバーの明示指示',
      }
    }
  }
  if (/(ガンマ|gamma)/i.test(intent)) {
    const digits = /(\d{1,3})/.exec(intent)
    const down = /(下げ|落と|弱め|decrease|lower)/i.test(intent)
    const amount = digits ? Number(digits[1]) * (down ? -1 : 1) : down ? -20 : 20
    return { tool: 'image.gamma', arguments: { amount }, reason: 'ガンマの明示指示' }
  }
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
  // 画像全体にかける明暗の調整（D-020 の photometric）。**局所補正はしない**
  if (/(コントラスト|contrast)/i.test(intent)) {
    const digits = /(\d{1,3})/.exec(intent)
    const down = /(下げ|弱め|低め|落と|decrease|lower|less)/i.test(intent)
    const amount = digits ? Number(digits[1]) * (down ? -1 : 1) : down ? -20 : 20
    return { tool: 'image.contrast', arguments: { amount }, reason: 'コントラストの明示指示' }
  }
  if (/(明る|暗く|明度|brightness|brighten|darken)/i.test(intent)) {
    const digits = /(\d{1,3})/.exec(intent)
    const darker = /(暗く|落と|darken)/i.test(intent)
    const amount = digits ? Number(digits[1]) * (darker ? -1 : 1) : darker ? -20 : 20
    return { tool: 'image.brightness', arguments: { amount }, reason: '明るさの明示指示' }
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

/**
 * 画素を作る操作を禁じている設定で、そこへ落ちようとしたときに理由を返す（D-020）。
 *
 * **落とし先を作らない**のが肝。規則ベースの既定は image.generate / image.edit へ
 * 落ちるが、どちらも禁じられている。黙って別のツールを動かすのが一番悪い（D-013 の実測）
 */
function assertAllowed(plan: ImageOperationPlan, context: PlanningContext): ImageOperationPlan {
  if (!context.forbidSynthesis) return plan
  if (imageToolDefinition(plan.tool).pixelOrigin !== 'synthesized') return plan
  throw new SynthesisForbiddenError(
    context.hasSourceImage
      ? 'この指示は画素を作る操作にしか割り当てられませんでした。回転・切り抜き・リサイズ・明るさ・コントラストなど、画素を作らない操作でお試しください'
      : 'まだ画像がありません。画素を作る操作を使わない設定では、左の「画像を取り込む」から始めてください',
  )
}

export function ruleBasedPlan(
  intent: string,
  context: PlanningContext,
): ImageOperationPlan {
  return validateImagePlan(
    assertAllowed(
      explicitRule(intent, context) ?? {
        tool: context.hasSourceImage ? 'image.edit' : 'image.generate',
        arguments: {},
        reason: context.hasSourceImage ? '既存画像への一般編集' : '新規画像生成',
      },
      context,
    ),
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

/**
 * 清書の書き方（D-026）。振り分けと、清書だけの頼み直しで**同じ文言を使う**——
 * 片方だけ直すと、頼み直しで質の違う文が返り、原因が追えなくなる
 */
const REWRITE_RULES = [
  'Write it in English. The image model cannot follow Japanese, so leaving the instruction untranslated silently produces a picture that ignores it.',
  'Rewrite faithfully: resolve ambiguity using the lineage and keep every explicit user constraint.',
  'Make vague style words concrete, so the image model has something to act on: "flat" becomes flat vector illustration with solid fills and uniform line weight; "simple" becomes few shapes and a limited palette. Expanding a style word the user did use is required. Adding subjects, objects, moods, or lettering the user never mentioned is not.',
  'State a removal as an explicit absence as well as an action: not only "remove the bow and arrow" but also "no bow, no arrow anywhere in the image".',
  'Say what must stay recognisable, but never write a blanket "preserve all existing colors and geometry": it cancels the requested change.',
  'Up to 4 sentences. Be specific rather than long.',
]

/** 1 回の送信で出せる候補の上限。1 枚 1〜3 分の直列実行なので、4 枚で 10 分前後になる */
export const MAX_VARIANTS = 4

/** 全角の数字を半角へ。指示は手で書かれるので、どちらでも来る */
function normalizeDigits(text: string): string {
  return text.replace(/[０-９]/g, (d) => String.fromCharCode(d.charCodeAt(0) - 0xfee0))
}

/**
 * 「候補を複数」と頼まれているか（D-018）。
 *
 * **数は読み取らない。** 何枚出すかは画面の「候補」で選んでもらう——
 * 自然言語から数を推測すると、外したときに黙って違う枚数が出る。ここで見るのは
 * 「複数を求めている指示なのに 1 枚設定になっている」ことに気づくためだけである。
 */
export function asksForMultipleCandidates(intent: string): boolean {
  const text = normalizeDigits(intent)
  const candidate = /(候補|案|パターン|バリエーション|variation|option)/i.test(text)
  const multiple =
    /(\d+\s*[つ個枚案]|[二三四五六七八九]\s*[つ個枚案]|複数|いくつか|several|multiple|\d+\s*(variations?|options?|patterns?))/i.test(
      text,
    )
  return candidate && multiple
}

/**
 * 方向の違う候補を作らせる（D-018 の B 段）。
 *
 * **ここだけ「頼まれていない様式を足すな」の縛りを外す。** 方向の違う案を作るとは、
 * 利用者が言っていない要素を足すことそのものだからである。
 *
 * 縛りは緩めるが、**外した事実は記録に残る**——実行された全文は `provision:prompt`、
 * 利用者の生の言葉は `provision:intent` として版ごとに別々に残るので、何を頼んで
 * 何が足されたかは常に突き合わせられる。だから新しい語彙は要らない。
 */
export async function proposeVariantPrompts(input: {
  intent: string
  /** 1 案だけ作るときに使う書き直し。ここからばらす */
  basePrompt: string
  count: number
  /** 描く文字列が決まっているなら、全案がそれを含まなければならない */
  text?: string
  lineage?: string[]
  planner: AiPlannerConfig & { apiKey: string }
  signal?: AbortSignal
}): Promise<string[]> {
  const count = Math.min(Math.max(Math.trunc(input.count), 2), MAX_VARIANTS)
  const prompt = [
    `You propose ${count} DIFFERENT directions for one image request.`,
    'Return JSON only: {"prompts":["...","..."]}.',
    `Give exactly ${count} concise English instructions for an image model.`,
    'Each must be a genuinely different direction — different composition, metaphor, or visual treatment. Do not restate the same idea in other words.',
    'Keep every explicit user constraint in all of them.',
    // 候補も同じ経路で画像モデルへ渡る。ここだけ緩いと、候補だけが指示から外れる
    ...REWRITE_RULES,
    ...(input.text
      ? [`Every prompt must contain the exact string ${JSON.stringify(input.text)}.`]
      : []),
    ...(input.lineage?.length
      ? [`Prior instructions in this lineage (oldest first): ${JSON.stringify(input.lineage)}`]
      : []),
    `User instruction: ${JSON.stringify(input.intent)}`,
    `Baseline prompt: ${JSON.stringify(input.basePrompt)}`,
  ].join('\n')

  const parsed = extractJson(await callPlanner(input.planner, prompt, input.signal)) as {
    prompts?: unknown
  }
  const unique = [
    ...new Set(
      (Array.isArray(parsed.prompts) ? parsed.prompts : [])
        .filter((value): value is string => typeof value === 'string')
        .map((value) => value.replace(/\s+/g, ' ').trim())
        .filter(
          (value) =>
            value.length > 0 &&
            value.length <= MAX_REWRITTEN_PROMPT_LENGTH &&
            !/[\u0000-\u001f\u007f]/.test(value) &&
            // 訳し漏れた案は画像モデルが汲めない。seed 違いへ落ちるほうがまだ良い
            !needsTranslation(value, input.text),
        )
        // 推定した文字列が落ちると、描画対象が失われる（validateImagePlan と同じ縛り）
        .filter((value) => !input.text || value.includes(input.text)),
    ),
  ]
  // 1 案しか残らないなら候補になっていない。seed 違いへ落として、そう伝える
  if (unique.length < 2) throw new Error('方向の違う案を作れませんでした')
  return unique.slice(0, count)
}

/**
 * 清書だけをもう一度頼む（D-026）。
 *
 * **ツールの選択はやり直さない。** 実測では振り分けは当たっていたのに清書だけが
 * 欠け（`prompt` が任意だった）、生の日本語がそのまま画像モデルへ渡っていた。
 * 計画ごと捨てると規則ベースへ落ちて別のツールが動く（D-013）ので、欠けた所だけ埋める。
 */
export async function rewriteInstruction(input: {
  intent: string
  /** 描く文字列が決まっているなら、清書はそれを含まなければならない */
  text?: string
  lineage?: string[]
  planner: AiPlannerConfig & { apiKey: string }
  signal?: AbortSignal
}): Promise<string> {
  const prompt = [
    'You rewrite one image request into the exact instruction an image model receives.',
    'Return JSON only: {"prompt":"..."}.',
    ...REWRITE_RULES,
    ...(input.text
      ? [`The prompt must contain the exact string ${JSON.stringify(input.text)}.`]
      : []),
    ...(input.lineage?.length
      ? [`Prior instructions in this lineage (oldest first): ${JSON.stringify(input.lineage)}`]
      : []),
    `User instruction: ${JSON.stringify(input.intent)}`,
  ].join('\n')

  const parsed = extractJson(await callPlanner(input.planner, prompt, input.signal)) as {
    prompt?: unknown
  }
  const rewritten =
    typeof parsed.prompt === 'string' ? parsed.prompt.replace(/\s+/g, ' ').trim() : ''
  if (
    !rewritten ||
    rewritten.length > MAX_REWRITTEN_PROMPT_LENGTH ||
    /[\u0000-\u001f\u007f]/.test(rewritten)
  ) {
    throw new Error('清書が空か、長さの上限を超えました')
  }
  // 訳せていないなら清書になっていない。渡しても画像モデルは汲めない
  if (needsTranslation(rewritten, input.text)) throw new Error('清書に日本語が残っています')
  if (input.text && !rewritten.includes(input.text)) {
    throw new Error('清書に描画対象の文字列が含まれていません')
  }
  return rewritten
}

export async function planImageOperation(input: {
  intent: string
  context: PlanningContext
  /** 系譜のこれまでの指示（根に近い順）。製品名などの文脈推定に使う */
  lineage?: string[]
  planner?: AiPlannerConfig & { apiKey: string }
  /**
   * 清書が欠けたときに、清書だけを頼み直すか（D-026）。既定は頼み直す。
   * **接続テストでは切る**——確かめたいのは繋がるかどうかで、2 度目の呼び出しは
   * 待ち時間を倍にするだけであり、そこで失敗しても接続は生きている
   */
  repairMissingPrompt?: boolean
  signal?: AbortSignal
}): Promise<PlannedImageOperation> {
  const deterministic = explicitRule(input.intent, input.context)
  if (deterministic) {
    return {
      plan: validateImagePlan(assertAllowed(deterministic, input.context), input.context),
      mode: 'rules',
    }
  }
  const fallback = ruleBasedPlan(input.intent, input.context)
  const planner = input.planner
  if (!planner?.enabled || !planner.modelId.trim()) return { plan: fallback, mode: 'rules' }

  const prompt = [
    'You route one image request to exactly one allowed tool.',
    'Return JSON only: {"tool":"...", "arguments":{}, "reason":"short reason", "prompt":"optional rewritten instruction"}.',
    'Allowed tools:',
    // 一覧は定義から組み立てる。ツールを足したときの書き漏れを構造で防ぐ
    toolCatalogForPrompt({ forbidSynthesis: input.context.forbidSynthesis }),
    'When the user asks to add lettering (wordmark/logotype), set arguments.text to the exact string (<=40 chars). Take it from the instruction, or from the lineage when the instruction does not name it. Omit arguments.text when no name is available anywhere.',
    'Context.parentTool is the tool that produced the current picture, and Context.parentText is the lettering it drew. When parentTool is image.wordmark and the user wants to change the gap, margin, or spacing around that lettering, choose image.wordmark again: set arguments.text to Context.parentText and arguments.padding in pixels (roughly 8 for tight, 24 for default, 60 for airy). The band is rebuilt from the artwork underneath, so nothing is lost. Do not use image.edit for that — the diffusion model repaints everything and drops the lettering.',
    // **省かせない**（D-026）。省くと生の日本語がそのまま画像モデルへ渡る
    'For image.generate and image.edit you must always set "prompt": this exact string is what the image model receives. If you omit it, the raw user text is sent instead and the edit comes out wrong.',
    'Also set "scope" for those two tools: "whole" when the instruction asks to restyle, simplify, abstract, flatten, redraw as a flat or solid illustration, change the art style, or otherwise remake the entire picture; "local" only when it changes one part or detail (a margin, one colour, one element). This decides whether the image model is told to redraw the whole picture. Getting it wrong no longer breaks the edit, but a restyle comes out weaker when it is marked "local".',
    'Examples of "whole": make it flat, make it simpler, abstract it, turn it into a line drawing, change the art style. Examples of "local": widen the margin, make the lettering smaller, change the background colour.',
    ...REWRITE_RULES,
    'If arguments.text is set, the rewritten prompt must contain that exact string.',
    `Context: ${JSON.stringify(input.context)}`,
    ...(input.lineage?.length
      ? [`Prior instructions in this lineage (oldest first): ${JSON.stringify(input.lineage)}`]
      : []),
    `User instruction: ${JSON.stringify(input.intent)}`,
  ].join('\n')

  try {
    const raw = await callPlanner(planner, prompt, input.signal)
    const plan = validateImagePlan(extractJson(raw), input.context)
    const planned: PlannedImageOperation = {
      plan,
      mode: 'llm',
      plannerProvider: planner.provider,
      plannerModel: planner.modelId,
    }
    /**
     * 清書が欠けた、または訳し漏れたときだけ、**清書だけ**を頼み直す（D-026）。
     * ここを素通りさせると、利用者の日本語がそのまま画像モデルへ渡る
     */
    if (
      input.repairMissingPrompt !== false &&
      imageToolDefinition(plan.tool).usesPrompt &&
      (!plan.prompt || needsTranslation(plan.prompt, plan.arguments.text))
    ) {
      try {
        planned.plan = {
          ...plan,
          prompt: await rewriteInstruction({
            intent: input.intent,
            text: plan.arguments.text,
            lineage: input.lineage,
            planner,
            signal: input.signal,
          }),
        }
      } catch (error) {
        // 計画は捨てない。選ばれたツールは当たっている（D-013）
        planned.warning = `指示を英語へ書き直せなかったため、利用者の言葉のまま画像モデルへ渡します: ${
          error instanceof Error ? error.message : String(error)
        }`
      }
    }
    return planned
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
