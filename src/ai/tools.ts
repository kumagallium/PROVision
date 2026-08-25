/**
 * 画像ツールの単一情報源。
 *
 * ここから LLM への説明文・引数の許可・前提条件・実行先・回帰テストを導く。
 * 定義が散っていたころ、ツールを 1 つ足すのに 3 ファイル 11 箇所を触る必要があり、
 * 1 箇所（prompt の許可）を落として無関係な絵が描かれた。**足し忘れが起きない形に
 * 畳むこと自体がこのファイルの目的**なので、ツールの性質はここ以外に書かない。
 *
 * 形は MCP のツール定義（name / description / inputSchema）に合わせてある。
 * 将来ここを MCP サーバとして出すなら、この配列をそのまま写せる。
 */

export type ImageToolName =
  | 'image.generate'
  | 'image.edit'
  | 'image.erase'
  | 'image.trim'
  | 'image.crop-square'
  | 'image.rotate'
  | 'image.resize'
  | 'image.wordmark'
  | 'background.remove'

/** 引数名。ツールごとに受け取れるものを accepts で宣言する */
export type ImageToolArgumentName = 'angle' | 'width' | 'height' | 'padding' | 'text'

/** 誰が実行するか。振り分けはこの値だけを見る */
export type ImageToolExecutor = 'image-model' | 'jimp' | 'inpaint' | 'background'

export interface ImageToolDefinition {
  name: ImageToolName
  executor: ImageToolExecutor
  /** LLM へ渡す説明。「何をするか」と「いつ選ぶか」 */
  purpose: string
  /** 選んではいけない場面。誤分類の歯止めで、LLM への説明にも足す */
  avoidWhen?: string
  /** 編集元画像の要否。'forbidden' は「あってはならない」 */
  requiresSourceImage: boolean | 'forbidden'
  /** 利用者が指定した編集範囲を必須にするか */
  requiresEditRegion?: boolean
  /** 欠けたら計画を拒む引数 */
  requiredArguments?: readonly ImageToolArgumentName[]
  /** 受け取れる引数。ここに無いものは黙って落とす */
  accepts: readonly ImageToolArgumentName[]
  /** 画像モデルへ渡す書き直しプロンプトを使うか */
  usesPrompt?: boolean
  /** 期待する振り分け。そのまま回帰テストになる */
  examples?: ReadonlyArray<{ intent: string; hasSourceImage?: boolean; hasEditRegion?: boolean }>
}

export const IMAGE_TOOLS: readonly ImageToolDefinition[] = [
  {
    name: 'image.generate',
    executor: 'image-model',
    purpose: 'create a new image when no source exists',
    requiresSourceImage: 'forbidden',
    accepts: ['text'],
    usesPrompt: true,
    examples: [{ intent: '星座をモチーフにしたロゴを作って', hasSourceImage: false }],
  },
  {
    name: 'image.edit',
    executor: 'image-model',
    purpose:
      'generative change to an existing image. Also use it to restyle, harmonize, resize, or reposition lettering that is already drawn',
    requiresSourceImage: true,
    accepts: ['text'],
    usesPrompt: true,
    examples: [
      { intent: 'もう少し落ち着いた配色にして' },
      { intent: '文字とロゴに統一感をもたせた形にしてください。' },
      { intent: '「asterism」の文字を少し小さくして' },
    ],
  },
  {
    name: 'image.erase',
    executor: 'inpaint',
    purpose: 'erase or heal the region the user selected, filling it from the surroundings',
    requiresSourceImage: true,
    requiresEditRegion: true,
    accepts: [],
    examples: [{ intent: '選択した部分を消して', hasEditRegion: true }],
  },
  {
    name: 'image.trim',
    executor: 'jimp',
    purpose: 'remove or equalize the margins around the artwork',
    requiresSourceImage: true,
    accepts: ['padding'],
    examples: [{ intent: '全体的な余白の調整をいい感じにして' }],
  },
  {
    name: 'image.crop-square',
    executor: 'jimp',
    purpose: 'center-crop to a square',
    requiresSourceImage: true,
    accepts: [],
    examples: [{ intent: '正方形に切り抜いて' }],
  },
  {
    name: 'image.rotate',
    executor: 'jimp',
    purpose: 'rotate the image; arguments.angle must be 90, 180, or 270',
    requiresSourceImage: true,
    requiredArguments: ['angle'],
    accepts: ['angle'],
    examples: [{ intent: '90度回転して' }],
  },
  {
    name: 'image.resize',
    executor: 'jimp',
    purpose: 'resize the image; arguments.width and arguments.height are pixels',
    requiresSourceImage: true,
    accepts: ['width', 'height'],
    examples: [{ intent: '600x400にリサイズして' }],
  },
  {
    name: 'image.wordmark',
    executor: 'jimp',
    purpose:
      'append a band below the image and draw a wordmark there with a font. Requires arguments.text. Choose it to ADD a name that is not in the picture yet — the lettering comes out exact, which diffusion cannot guarantee. If the name is not stated in the instruction, take it from the lineage',
    avoidWhen:
      'the image already shows that text, or the user asks to restyle, harmonize, resize, or reposition existing lettering — this tool cannot see what is already drawn, so it would duplicate the text. Use image.edit instead',
    requiresSourceImage: true,
    requiredArguments: ['text'],
    accepts: ['text'],
    examples: [
      { intent: '「asterism」というロゴタイプを付けて' },
      { intent: 'ロゴタイプを追加してください' },
    ],
  },
  {
    name: 'background.remove',
    executor: 'background',
    purpose: 'make the background transparent',
    requiresSourceImage: true,
    accepts: [],
    examples: [{ intent: '背景を透明にして' }],
  },
]

/** 画面へ出すときの引数名。機械的な英名だけだと利用者に伝わらない */
export const ARGUMENT_LABELS: Record<ImageToolArgumentName, string> = {
  angle: '回転角度（angle）',
  width: '幅（width）',
  height: '高さ（height）',
  padding: '余白（padding）',
  text: '描く文字列（text）',
}

const BY_NAME = new Map<ImageToolName, ImageToolDefinition>(
  IMAGE_TOOLS.map((tool) => [tool.name, tool]),
)

export function imageToolDefinition(name: ImageToolName): ImageToolDefinition {
  const tool = BY_NAME.get(name)
  if (!tool) throw new Error(`未対応の画像ツールです: ${name}`)
  return tool
}

export function isImageToolName(value: unknown): value is ImageToolName {
  return typeof value === 'string' && BY_NAME.has(value as ImageToolName)
}

export function imageToolExecutor(name: ImageToolName): ImageToolExecutor {
  return imageToolDefinition(name).executor
}

/** LLM へ渡すツール一覧。説明文を定義から組み立てるので、書き漏れが起きない */
export function toolCatalogForPrompt(): string {
  return IMAGE_TOOLS.map((tool) => {
    const parts = [`- ${tool.name}: ${tool.purpose}`]
    if (tool.requiresEditRegion) parts.push('requires a user-selected edit region')
    if (tool.avoidWhen) parts.push(`Do not choose it when ${tool.avoidWhen}`)
    return `${parts.join('. ')}.`
  }).join('\n')
}
