/**
 * 手元の拡散モデルで 1 枚生成する。geo-logo の image-agent から command プロバイダだけ移した。
 *
 * 移植にあたって持ち込んだ実測（geo-logo で実害が出たもの）:
 *   - 量子化済みモデルを使う。フル精度は読み込みだけで 27GB でマシンが固まる
 *   - 絶対パスで呼ぶ。GUI から起動されると PATH が /usr/bin:/bin 程度しかない
 *   - 生成は直列に捌く。並行させるとピークメモリで落ちる（この関数は待ち合わせる）
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from '../prov/sha256.js'

const execFileAsync = promisify(execFile)

/**
 * 生成の既定値。キャッシュ鍵の計算と実行の両方で使うので、必ずここだけを見る
 * （2 箇所に散らすと、鍵と実物が食い違って別物をキャッシュから返す）。
 *
 * 1024 ではなく 768 なのは実測による。M1 Max で 1 枚あたり
 * 1024px は 768px の約 2.07 倍かかる（実測 112/54・150/71・200/96 秒）うえ、
 * 1024px はロゴ指示でも濃い背景色を敷きがちで、素材として扱いにくい絵が出る。
 * 768px のほうが速くて、かつ白背景の線画で出る。
 */
const DEFAULT_WIDTH = 768
const DEFAULT_HEIGHT = 768
export const DEFAULT_STEPS = 8

export interface GenerateInput {
  prompt: string
  seed: number
  width?: number
  height?: number
  steps?: number
  /** image-to-image の入力画像。{image} を含むコマンドでのみ有効 */
  imagePath?: string
  /** 入力画像の内容ハッシュ。キャッシュ鍵に使う */
  imageDigest?: string
  imageStrength?: number
  /** 再実行のときだけ渡す。記録されたモデルで走らせる（足元の既定を引き直さない） */
  model?: string
}

export interface GenerateResult {
  png: Uint8Array
  model: string
  provider: string
  startedAtTime: string
  endedAtTime: string
}

/**
 * 生成 1 回ぶんのキャッシュ鍵。同じ入力なら同じ鍵になる。
 *
 * 1 枚 2〜3 分かかるので、途中で落ちたときに最初からやり直したくない。
 * 鍵は「再現に要る情報」そのもの（D-002）なので、鍵が一致するなら
 * 再実行しても同じ絵が出るはず、という前提と一致する。
 */
export function cacheKeyOf(input: GenerateInput, model: string): string {
  return sha256(
    [
      input.prompt,
      String(input.seed),
      String(input.width ?? DEFAULT_WIDTH),
      String(input.height ?? DEFAULT_HEIGHT),
      String(input.steps ?? DEFAULT_STEPS),
      input.imageDigest ?? input.imagePath ?? '',
      String(input.imageStrength ?? ''),
      model,
    ].join('\u0000'),
  ).slice(0, 32)
}

/**
 * 手元に置かれた z-image-turbo を、質の良い順に探す。
 *
 * 量子化ビット数で決めるのは、実測でこうなったため（768px / 8step / 同一 seed）:
 *
 *   | 量子化 | ピークメモリ | ディスク | 出力                          |
 *   | 4bit   | 7.58GB       | 5.5GB    | 灰色のにじみが残る            |
 *   | 5bit   | 8.35GB       | 6.7GB    | 4bit の改善ではなく別の絵     |
 *   | 6bit   | 9.12GB       | 7.9GB    | 8bit と見分けがつかない       |
 *   | 8bit   | 10.65GB      | 10GB     | 6bit と同じ（払い損）         |
 *
 * 生成時間は 4 段階とも変わらない。よって 6bit が上限で、8bit を選ぶ理由は無い。
 * 5bit を 4bit より上に置かないのは、良くなるのではなく別物が出るため。
 *
 * ここで 1 つに決め打ちしないのは、必要メモリが機種の搭載量に直接効くから。
 * 16GB 機は 4bit、余裕のある機械は 6bit、と利用者が置いたもので決まるようにする。
 */
export const MODEL_DIRS_BEST_FIRST = ['z-image-turbo-6bit', 'z-image-turbo-4bit'] as const

/** 編集特化モデルの置き場の名前。`--model flux2-klein-4b --quantize 8` が返す識別子と同じ綴り */
export const EDIT_MODEL_DIR = 'flux2-klein-4b-q8'

/**
 * 置き場。`provision` が本来の場所で、`geologo` は前身プロジェクトの置き場。
 * 後者を探し続けるのは、すでにそこへ置いている人の手元を壊さないため。
 * どちらに置いても記録される識別子はディレクトリ名ではなくモデル名なので、
 * 場所を移しても再現の突き合わせには影響しない。
 */
export const MODEL_CACHE_DIRS = ['provision', 'geologo'] as const

/** その名前のモデルが置かれている場所。無ければ null。`exists` を差し替えられるのはテストのため */
export function savedModelPath(
  name: string,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  for (const dir of MODEL_CACHE_DIRS) {
    const path = join(home, '.cache', dir, name)
    if (exists(path)) return path
  }
  return null
}

/**
 * `uv tool install` が実行ファイルを置く場所。導入（D-029）もここを前提にするので、
 * 置き場を変えるならこの 1 か所で変える。
 */
export function mfluxBinPath(name: string, home: string = homedir()): string {
  return join(home, '.local', 'bin', name)
}

/** 候補の名前を良い順に探す。導入（D-029）も同じ順で「もうある」を判定する */
export function findSavedModel(
  namesBestFirst: readonly string[] = MODEL_DIRS_BEST_FIRST,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  // 量子化の質を場所より優先する。6bit がどちらかにあれば、それを使う
  for (const name of namesBestFirst) {
    const path = savedModelPath(name, exists, home)
    if (path) return path
  }
  return null
}

/**
 * この Mac で使える既定コマンド。量子化済みの z-image-turbo が無ければ null。
 * 環境変数 PROVISION_IMAGE_COMMAND があればそちらが優先される。
 *
 * テンプレートは {promptFile} {seed} {width} {height} {steps} {image}
 * {imageStrength} {out} を差し替える。{image} は親画像を編集するときだけ使う。
 */
export function suggestImageCommand(): string | null {
  const bin = mfluxBinPath('mflux-generate-z-image-turbo')
  const saved = findSavedModel()
  if (!existsSync(bin) || !saved) return null
  return [
    bin,
    `--model ${saved}`,
    '--base-model z-image-turbo',
    '--prompt-file {promptFile}',
    '--seed {seed}',
    '--width {width}',
    '--height {height}',
    '--steps {steps}',
    '--image {image} {imageStrength}',
    '--output {out}',
  ].join(' ')
}

/**
 * 親画像を編集するときのコマンド。生成用と分けるのは、編集特化モデルが
 * 入力画像を必須に取り、新規生成に使えないため（mflux-generate-flux2-edit は
 * --image-paths が必須）。汎用の生成モデルで編集させると文字が崩れる実測がある。
 */
export function suggestImageEditCommand(): string | null {
  const bin = mfluxBinPath('mflux-generate-flux2-edit')
  if (!existsSync(bin)) return null
  const tail = [
    '--image-paths {image}',
    '--prompt-file {promptFile}',
    '--seed {seed}',
    '--steps {steps}',
    '--output {out}',
  ]

  // 量子化済みを手元に保存してあれば、そちらを読む。
  //
  // `--quantize 8` を毎回渡すと、全精度 15GB を読んでから量子化するので、
  // ピークが量子化後ではなく読み込み時で決まる。実測でここが効いた:
  // ピーク 13.60GB → 9.96GB（-3.64GB）。所要時間は変わらない。
  // 出てくる画素は現行と完全一致するので、絵は 1 ドットも変わらない。
  //
  // 置き場の名前をそのまま識別子にしている（modelIdOf はディレクトリ名を返す）。
  // `flux2-klein-4b-q8` は `--model flux2-klein-4b --quantize 8` が返す識別子と
  // 同じ綴りで、実際に同じ重み・同じ量子化なので、過去の版の再現も壊れない。
  const saved = findSavedModel([EDIT_MODEL_DIR])
  if (saved) {
    return [bin, `--model ${saved}`, '--base-model flux2-klein-4b', ...tail].join(' ')
  }

  return [bin, '--model flux2-klein-4b', '--quantize 8', ...tail].join(' ')
}

/**
 * 記録されたモデルで走らせるためのコマンドを組む。**再実行専用。**
 *
 * 記録どおりの prompt / seed / steps / サイズで走らせておきながら、モデルだけ
 * 足元の既定を引き直すと、出てきた絵が違うのは当たり前になる。それを
 * 「再実行で食い違った」と記録すると、元の生成が非決定的だったという誤った
 * 結論が残る。食い違いの原因は、こちらがモデルを差し替えたことなので（D-002）。
 *
 * 探す順:
 *   1. いまの既定が記録と同じモデルなら、それをそのまま使う
 *      （編集用の flux2-klein-4b-q8 のように、ローカルの置き場を持たない
 *        識別子でも、一致していれば再実行できる）
 *   2. 記録と同じ名前の置き場が手元にあれば、そこを指す
 *      （既定を 6bit へ上げても、4bit を残している限り昔の版を再現できる）
 *   3. どちらも無ければ再実行しない。黙って別のモデルで走らせない
 */
export function resolveImageCommandForModel(
  recordedModel: string,
  options: { edit: boolean; env?: NodeJS.ProcessEnv } = { edit: false },
): string {
  const env = options.env ?? process.env
  const current = options.edit ? resolveImageEditCommand(env) : resolveImageCommand(env)
  if (modelIdOf(current) === recordedModel) return current

  for (const dir of MODEL_CACHE_DIRS) {
    const path = join(homedir(), '.cache', dir, recordedModel)
    if (!existsSync(path)) continue
    // 置き場が見つかったら、既定コマンドの --model だけを差し替える。
    // 他の引数（--base-model や置換子）は既定のまま使う
    return checkTemplate(current.replace(/--model\s+\S+/, `--model ${path}`))
  }

  throw new Error(
    `記録されたモデルが手元に無いので再実行できない: ${recordedModel}` +
      `（いまの既定は ${modelIdOf(current)}）。` +
      `そのモデルを ~/.cache/provision/${recordedModel} に置くか、` +
      'PROVISION_IMAGE_COMMAND で指す',
  )
}

function checkTemplate(template: string): string {
  if (!template.includes('{out}')) {
    throw new Error('コマンドに {out} が要る（そこへ PNG を書いてもらう）')
  }
  return template
}

/**
 * 生成器が手元に無い。設定不足であって故障ではないので、画面はここから導入へ誘導する（D-029）。
 * `code` は API の応答に載せる。文言で判定させると、文言を直した瞬間に誘導が消える。
 */
export class ImageCommandMissingError extends Error {
  readonly code = 'image-command-missing' as const

  constructor() {
    super(
      '画像生成コマンドが見つからない。設定の「画像生成」から導入するか、' +
        'PROVISION_IMAGE_COMMAND を設定する。手で置くなら mflux の量子化済み z-image-turbo を ' +
        '~/.cache/provision/z-image-turbo-6bit に' +
        '（作り方: mflux-save --model z-image-turbo --quantize 6 --path <その場所>）',
    )
    this.name = 'ImageCommandMissingError'
  }
}

export function resolveImageCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROVISION_IMAGE_COMMAND?.trim()
  const template = configured || suggestImageCommand()
  if (!template) throw new ImageCommandMissingError()
  return checkTemplate(template)
}

/** 編集用。専用コマンドが無ければ生成用へ落とす（従来どおり動く） */
export function resolveImageEditCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROVISION_IMAGE_EDIT_COMMAND?.trim()
  const template = configured || suggestImageEditCommand()
  return template ? checkTemplate(template) : resolveImageCommand(env)
}

/** モデル識別子。再現に要るので、記録できる形で返す */
export function modelIdOf(template: string): string {
  const m = template.match(/--model\s+(\S+)/)
  const base = m
    ? (m[1]!.split('/').pop() ?? m[1]!)
    : (template.trim().split(/\s+/)[0]!.split('/').pop() ?? 'unknown')
  // 同じ重みでも量子化が違えば絵が変わる。再現に要るので識別子へ畳む（D-002）。
  // ローカルパスに 4bit のように焼き込まれている場合は二重に付けない
  const quantize = template.match(/(?:--quantize|-q)\s+([3-8])/)?.[1]
  if (!quantize || new RegExp(`(^|[^0-9])${quantize}bit`, 'i').test(base)) return base
  return `${base}-q${quantize}`
}

export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  const template = input.model
    ? resolveImageCommandForModel(input.model, { edit: Boolean(input.imagePath) })
    : input.imagePath
      ? resolveImageEditCommand()
      : resolveImageCommand()
  const width = input.width ?? DEFAULT_WIDTH
  const height = input.height ?? DEFAULT_HEIGHT
  const steps = input.steps ?? DEFAULT_STEPS
  const imageStrength = input.imageStrength ?? 0.3
  const hasImagePlaceholder = template.includes('{image}')
  const canInjectMfluxImage = template.includes('mflux-generate')

  if (input.imagePath && !hasImagePlaceholder && !canInjectMfluxImage) {
    throw new Error(
      '親画像を編集するには画像入力に対応したコマンドが要る。' +
        'テンプレートへ --image {image} を追加する',
    )
  }
  if (input.imagePath && !existsSync(input.imagePath)) {
    throw new Error(`編集元の画像が見つからない: ${input.imagePath}`)
  }

  const dir = await mkdtemp(join(tmpdir(), 'provision-'))
  const out = join(dir, 'image.png')
  const promptFile = join(dir, 'prompt.txt')
  await writeFile(promptFile, input.prompt, 'utf8')

  const fill = (s: string) =>
    s
      .replaceAll('{promptFile}', promptFile)
      .replaceAll('{out}', out)
      .replaceAll('{seed}', String(input.seed))
      .replaceAll('{width}', String(width))
      .replaceAll('{height}', String(height))
      .replaceAll('{steps}', String(steps))
      .replaceAll('{image}', input.imagePath ?? '')
      .replaceAll('{imageStrength}', String(imageStrength))

  const templateArgs = template.trim().split(/\s+/)
  const args: string[] = []
  for (let i = 0; i < templateArgs.length; i += 1) {
    const arg = templateArgs[i]!
    if (!input.imagePath && arg === '--image' && templateArgs[i + 1] === '{image}') {
      i += 1
      if (templateArgs[i + 1] === '{imageStrength}') i += 1
      continue
    }
    // flux2-edit は --image-paths、kontext は --image-path と、編集系で綴りが割れる
    if (
      !input.imagePath &&
      (arg === '--image-path' || arg === '--image-paths') &&
      templateArgs[i + 1] === '{image}'
    ) {
      i += 1
      continue
    }
    if (
      !input.imagePath &&
      arg === '--image-strength' &&
      templateArgs[i + 1] === '{imageStrength}'
    ) {
      i += 1
      continue
    }
    args.push(fill(arg))
  }
  const [bin] = args.splice(0, 1)
  if (input.imagePath && !hasImagePlaceholder) {
    args.push('--image', input.imagePath, String(imageStrength))
  }
  const startedAtTime = new Date().toISOString()
  try {
    await execFileAsync(bin!, args, { maxBuffer: 64 * 1024 * 1024 })
    const png = new Uint8Array(await readFile(out))
    return {
      png,
      model: modelIdOf(template),
      provider: `command:${bin!.split('/').pop()}`,
      startedAtTime,
      endedAtTime: new Date().toISOString(),
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(`手元の生成器が PNG を書かなかった: ${why}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
