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
  | 'image.brightness'
  | 'image.contrast'
  | 'background.remove'
  | 'image.import'

/** 引数名。ツールごとに受け取れるものを accepts で宣言する */
export type ImageToolArgumentName =
  | 'angle'
  | 'width'
  | 'height'
  | 'padding'
  | 'text'
  | 'amount'

/** 誰が実行するか。振り分けはこの値だけを見る */
export type ImageToolExecutor = 'image-model' | 'jimp' | 'inpaint' | 'background' | 'import'

/**
 * 別の PC で同じ指定を出したとき、どこまで同じ絵になるか（D-016）。
 *
 * - `deterministic`: 整数・確定的な演算だけ。どの PC でも同じ画素になる
 * - `environment-dependent`: 乱数は使わないが、モデルとバージョンが一致して初めて同じ
 * - `stochastic`: 環境が変われば変わりうる。ビット一致は保証しない（D-015）
 * - `external`: **再現の対象外。元のファイルが要る**（取り込み。D-019）
 *
 * `external` を `stochastic` に潰さない。「環境が変われば変わりうる」と
 * 「そもそも記録から作れない」は別のことで、混ぜると系譜全体の等級の意味が壊れる。
 */
export type ReproducibilityGrade =
  | 'deterministic'
  | 'environment-dependent'
  | 'stochastic'
  | 'external'

/**
 * 等級は **executor 単位**で持つ。ツール単位に散らすと、ツールを 1 つ足したときに
 * 書き忘れて無印の辺が生まれる（D-012 がツール定義を畳んだのと同じ動機）。
 */
export const EXECUTOR_REPRODUCIBILITY: Record<ImageToolExecutor, ReproducibilityGrade> = {
  jimp: 'deterministic',
  inpaint: 'environment-dependent',
  background: 'environment-dependent',
  'image-model': 'stochastic',
  import: 'external',
}

/**
 * その一手が画素をどう触ったか（D-020）。**再現の等級とは独立した軸**である。
 *
 * LaMa は乱数を使わないので等級は `environment-dependent` だが、消した領域を周囲から
 * **描いている**。実験画像でそれをやれば、再現できようができまいが改ざんである。
 * 軸が 1 本しかないと、この 2 つが 1 本に潰れ、`environment-dependent` が
 * 「安全」と読まれる。
 *
 * - `geometric`: 位置と補間だけ。内容の追加も除去もない
 * - `annotated`: 元の画素を残したまま、確定的な描画を重ねる・余白を足す
 * - `photometric`: 画素値を変えるが、**画像全体に同じ規則で**。局所的に差をつけない
 * - `removed`: 画素を消す（透明にする）だけ。足さない
 * - `synthesized`: **入力に無かった内容を作った**
 * - `external`: **この画素が何を経てきたかは、この記録の外にある**（取り込み。D-019）
 */
export type PixelOrigin =
  | 'geometric'
  | 'annotated'
  | 'photometric'
  | 'removed'
  | 'synthesized'
  | 'external'

/**
 * 強い順。**`external` は入れない**——「外から来た」は画素への触り方ではなく、
 * 記録がそこで途切れるという別の事実だから（D-020）。
 *
 * 序列は「元の画素にどこまで手を入れたか」で並ぶ:
 * 何も変えない → 足す → 変える → 消す → 作る。
 */
const PIXEL_ORIGIN_STRENGTH: readonly PixelOrigin[] = [
  'geometric',
  'annotated',
  'photometric',
  'removed',
  'synthesized',
]

export interface ImageToolDefinition {
  name: ImageToolName
  executor: ImageToolExecutor
  /**
   * 画素をどう触ったか（D-020）。**executor 単位では持てない**——Jimp の回転
   * （`geometric`）と、これから足す明るさ調整（`photometric`）は同じ実行先で性質が違う。
   * **省略可にしない。** 型で強制すれば、ツールを 1 つ足した時点でコンパイルが通らない。
   */
  pixelOrigin: PixelOrigin
  /** LLM へ渡す説明。「何をするか」と「いつ選ぶか」 */
  purpose: string
  /** 選んではいけない場面。誤分類の歯止めで、LLM への説明にも足す */
  avoidWhen?: string
  /**
   * 指示から選べるか。**既定は選べる。** 取り込みのように、利用者のファイル操作から
   * 直接起きるツールだけ false にする。false のものは LLM へ渡す一覧にも載せず、
   * 計画の検証でも拒む——「取り込んで」と言われても、渡すファイルが無い
   */
  selectableByInstruction?: boolean
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
    pixelOrigin: 'synthesized',
    purpose: 'create a new image when no source exists',
    requiresSourceImage: 'forbidden',
    accepts: ['text'],
    usesPrompt: true,
    examples: [{ intent: '星座をモチーフにしたロゴを作って', hasSourceImage: false }],
  },
  {
    name: 'image.edit',
    executor: 'image-model',
    pixelOrigin: 'synthesized',
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
    pixelOrigin: 'synthesized',
    purpose: 'erase or heal the region the user selected, filling it from the surroundings',
    requiresSourceImage: true,
    requiresEditRegion: true,
    accepts: [],
    examples: [{ intent: '選択した部分を消して', hasEditRegion: true }],
  },
  {
    name: 'image.trim',
    executor: 'jimp',
    pixelOrigin: 'geometric',
    purpose: 'remove or equalize the margins around the artwork',
    requiresSourceImage: true,
    accepts: ['padding'],
    examples: [{ intent: '全体的な余白の調整をいい感じにして' }],
  },
  {
    name: 'image.crop-square',
    executor: 'jimp',
    pixelOrigin: 'geometric',
    purpose: 'center-crop to a square',
    requiresSourceImage: true,
    accepts: [],
    examples: [{ intent: '正方形に切り抜いて' }],
  },
  {
    name: 'image.rotate',
    executor: 'jimp',
    pixelOrigin: 'geometric',
    purpose: 'rotate the image; arguments.angle must be 90, 180, or 270',
    requiresSourceImage: true,
    requiredArguments: ['angle'],
    accepts: ['angle'],
    examples: [{ intent: '90度回転して' }],
  },
  {
    name: 'image.resize',
    executor: 'jimp',
    pixelOrigin: 'geometric',
    purpose: 'resize the image; arguments.width and arguments.height are pixels',
    requiresSourceImage: true,
    accepts: ['width', 'height'],
    examples: [{ intent: '600x400にリサイズして' }],
  },
  {
    name: 'image.wordmark',
    executor: 'jimp',
    pixelOrigin: 'annotated',
    purpose:
      'append a band below the image and draw a wordmark there with a font. Requires arguments.text. Choose it to ADD a name that is not in the picture yet — the lettering comes out exact, which diffusion cannot guarantee. If the name is not stated in the instruction, take it from the lineage. Also choose it to change the gap between the artwork and a wordmark this tool drew earlier: set arguments.padding (pixels above and below the lettering) and the band is rebuilt from the original artwork, so the lettering never gets lost',
    avoidWhen:
      'the picture shows lettering this tool did not draw, or the user asks to restyle or recolor it — this tool cannot see what is already drawn. Use image.edit instead',
    requiresSourceImage: true,
    requiredArguments: ['text'],
    accepts: ['text', 'padding'],
    examples: [
      { intent: '「asterism」というロゴタイプを付けて' },
      { intent: 'ロゴタイプを追加してください' },
      { intent: 'ロゴとロゴタイプの間の余白を広げて' },
    ],
  },
  {
    name: 'image.brightness',
    executor: 'jimp',
    pixelOrigin: 'photometric',
    purpose:
      'change the brightness of the WHOLE image by the same rule; arguments.amount is the percent change, where 0 keeps it, 20 brightens by 20%, and -50 halves it',
    requiresSourceImage: true,
    requiredArguments: ['amount'],
    accepts: ['amount'],
    examples: [{ intent: '20%明るくして' }, { intent: '少し暗くして' }],
  },
  {
    name: 'image.contrast',
    executor: 'jimp',
    pixelOrigin: 'photometric',
    purpose:
      'change the contrast of the WHOLE image by the same rule; arguments.amount is -100 to 100 and 0 keeps it',
    requiresSourceImage: true,
    requiredArguments: ['amount'],
    accepts: ['amount'],
    examples: [{ intent: 'コントラストを30上げて' }, { intent: 'コントラストを下げて' }],
  },
  {
    name: 'background.remove',
    executor: 'background',
    pixelOrigin: 'removed',
    purpose: 'make the background transparent',
    requiresSourceImage: true,
    accepts: [],
    examples: [{ intent: '背景を透明にして' }],
  },
  {
    name: 'image.import',
    executor: 'import',
    pixelOrigin: 'external',
    purpose: 'record an image brought in from outside PROVision',
    // 画面のファイル操作からしか起きない。指示からは選ばせない（D-019）
    selectableByInstruction: false,
    requiresSourceImage: 'forbidden',
    accepts: [],
  },
]

/** 画面へ出すときの引数名。機械的な英名だけだと利用者に伝わらない */
export const ARGUMENT_LABELS: Record<ImageToolArgumentName, string> = {
  angle: '回転角度（angle）',
  width: '幅（width）',
  height: '高さ（height）',
  padding: '余白（padding）',
  text: '描く文字列（text）',
  amount: '変化量（amount、％）',
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

/** そのツールで作った版が、別の PC でどこまで再現するか（D-016） */
export function imageToolReproducibility(name: ImageToolName): ReproducibilityGrade {
  return EXECUTOR_REPRODUCIBILITY[imageToolExecutor(name)]
}

/** 系譜全体の等級。**一番弱い辺に落ちる**——1 本でも再現しなければ鎖は再現しない */
export function weakestReproducibility(
  grades: readonly ReproducibilityGrade[],
): ReproducibilityGrade {
  // 取り込みが一番弱い。元のファイルが手元に無ければ、他がどれだけ確定的でも作れない
  if (grades.includes('external')) return 'external'
  if (grades.includes('stochastic')) return 'stochastic'
  if (grades.includes('environment-dependent')) return 'environment-dependent'
  return 'deterministic'
}

/** 画面へ出すときの等級名 */
export const REPRODUCIBILITY_LABELS: Record<ReproducibilityGrade, string> = {
  deterministic: 'どの PC でも同じ絵になる',
  'environment-dependent': 'ツールの版が同じなら同じ絵になる',
  stochastic: '環境が変わると絵も変わりうる',
  external: '外から取り込んだので、元のファイルが要る',
}

/** そのツールが画素をどう触るか（D-020） */
export function imageToolPixelOrigin(name: ImageToolName): PixelOrigin {
  return imageToolDefinition(name).pixelOrigin
}

export interface LineagePixelOrigin {
  /** 一番強い辺。`synthesized` が 1 本でもあればそれになる */
  strongest: PixelOrigin
  /**
   * 画素を作った手の本数。**割合や真偽ではなく本数で返す。**
   * 0 が「1 本も無かった」なのか「そもそも見ていない」なのか区別できなくなるため（D-017）
   */
  synthesized: number
  /** 数えた辺の本数。`counted` が 0 なら、まだ何も見ていない */
  counted: number
  /** 取り込み点を含むか。含むなら**その手前は記録の外**（D-019 / D-020） */
  hasExternal: boolean
}

/**
 * 系譜全体の画素の由来。**等級が一番弱い辺へ落ちる（D-016）のと対で、こちらは
 * 一番強い辺へ上がる。** 1 本でも生成を通っていれば、その版は生成を通っている。
 *
 * `external` は強さの序列に入れず、別に併記する（D-020）。取り込んだ画像より前を
 * PROVision は見ていないので、`synthesized` が 0 本でも「画素を作っていない」とは
 * 言い切れない。この限界を集約の戻り値から落とすと、画面から消える。
 */
export function lineagePixelOrigin(origins: readonly PixelOrigin[]): LineagePixelOrigin {
  let rank = 0
  let synthesized = 0
  for (const origin of origins) {
    const index = PIXEL_ORIGIN_STRENGTH.indexOf(origin)
    if (index > rank) rank = index
    if (origin === 'synthesized') synthesized += 1
  }
  return {
    strongest: PIXEL_ORIGIN_STRENGTH[rank]!,
    synthesized,
    counted: origins.length,
    hasExternal: origins.includes('external'),
  }
}

/**
 * 画面へ出すときの言い方。**「改ざんされていない」とは書かない**（D-020）。
 * 言えるのは「記録したツールのうち画素を作るものを通ったか」までである。
 */
export const PIXEL_ORIGIN_LABELS: Record<PixelOrigin, string> = {
  geometric: '位置と大きさを変えただけで、画素は作っていない',
  annotated: '元の画素は残したまま、文字や余白を足した',
  photometric: '画像全体に同じ規則で明暗を変えた',
  removed: '画素を消した（足してはいない）',
  synthesized: '入力に無かった画素を作った',
  external: '外から取り込んだ。この手前は記録の外',
}

/** 指示から選べるツールか（D-019）。取り込みだけ選べない */
export function isSelectableByInstruction(name: ImageToolName): boolean {
  return imageToolDefinition(name).selectableByInstruction !== false
}

/**
 * LLM へ渡すツール一覧。説明文を定義から組み立てるので、書き漏れが起きない。
 * **指示から選べないツールは載せない**——載せると選ばれてしまう
 */
export function toolCatalogForPrompt(options: { forbidSynthesis?: boolean } = {}): string {
  const lines = IMAGE_TOOLS.filter(
    (tool) =>
      tool.selectableByInstruction !== false &&
      // 禁じているものを見せると選ばれる。選ばせてから拒むより、初めから見せない（D-020）
      !(options.forbidSynthesis && tool.pixelOrigin === 'synthesized'),
  ).map((tool) => {
    const parts = [`- ${tool.name}: ${tool.purpose}`]
    if (tool.requiresEditRegion) parts.push('requires a user-selected edit region')
    if (tool.avoidWhen) parts.push(`Do not choose it when ${tool.avoidWhen}`)
    return `${parts.join('. ')}.`
  })
  if (options.forbidSynthesis) {
    // 一覧から外しても、別のツールの注意書きが禁じたツールを名指しすることがある
    // （image.wordmark の「Use image.edit instead」）。名指しされても選ばせない
    lines.push(
      'Choose only from the tools listed above. Other tool names may appear inside these descriptions; those are not available.',
    )
  }
  return lines.join('\n')
}
