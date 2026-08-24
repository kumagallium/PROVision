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
      String(input.width ?? 1024),
      String(input.height ?? 1024),
      String(input.steps ?? 8),
      input.imageDigest ?? input.imagePath ?? '',
      String(input.imageStrength ?? ''),
      model,
    ].join('\u0000'),
  ).slice(0, 32)
}

/**
 * この Mac で使える既定コマンド。量子化済みの z-image-turbo が無ければ null。
 * 環境変数 PROVISION_IMAGE_COMMAND があればそちらが優先される。
 *
 * テンプレートは {promptFile} {seed} {width} {height} {steps} {image}
 * {imageStrength} {out} を差し替える。{image} は親画像を編集するときだけ使う。
 */
export function suggestImageCommand(): string | null {
  const bin = join(homedir(), '.local', 'bin', 'mflux-generate-z-image-turbo')
  const saved = join(homedir(), '.cache', 'geologo', 'z-image-turbo-4bit')
  if (!existsSync(bin) || !existsSync(saved)) return null
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
  const bin = join(homedir(), '.local', 'bin', 'mflux-generate-flux2-edit')
  if (!existsSync(bin)) return null
  return [
    bin,
    '--model flux2-klein-4b',
    '--quantize 8',
    '--image-paths {image}',
    '--prompt-file {promptFile}',
    '--seed {seed}',
    '--steps {steps}',
    '--output {out}',
  ].join(' ')
}

function checkTemplate(template: string): string {
  if (!template.includes('{out}')) {
    throw new Error('コマンドに {out} が要る（そこへ PNG を書いてもらう）')
  }
  return template
}

export function resolveImageCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROVISION_IMAGE_COMMAND?.trim()
  const template = configured || suggestImageCommand()
  if (!template) {
    throw new Error(
      '画像生成コマンドが見つからない。PROVISION_IMAGE_COMMAND を設定するか、' +
        'mflux の量子化済み z-image-turbo を ~/.cache/geologo/z-image-turbo-4bit に置く',
    )
  }
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
  const template = input.imagePath ? resolveImageEditCommand() : resolveImageCommand()
  const width = input.width ?? 1024
  const height = input.height ?? 1024
  const steps = input.steps ?? 8
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
