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
      model,
    ].join('\u0000'),
  ).slice(0, 32)
}

/**
 * この Mac で使える既定コマンド。量子化済みの z-image-turbo が無ければ null。
 * 環境変数 PROVISION_IMAGE_COMMAND があればそちらが優先される。
 *
 * テンプレートは {promptFile} {seed} {width} {height} {steps} {out} を差し替える。
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
    '--output {out}',
  ].join(' ')
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
  if (!template.includes('{out}')) {
    throw new Error('コマンドに {out} が要る（そこへ PNG を書いてもらう）')
  }
  return template
}

/** モデル識別子。再現に要るので、記録できる形で返す */
export function modelIdOf(template: string): string {
  const m = template.match(/--model\s+(\S+)/)
  if (m) return m[1]!.split('/').pop() ?? m[1]!
  return template.trim().split(/\s+/)[0]!.split('/').pop() ?? 'unknown'
}

export async function generateImage(input: GenerateInput): Promise<GenerateResult> {
  const template = resolveImageCommand()
  const width = input.width ?? 1024
  const height = input.height ?? 1024
  const steps = input.steps ?? 8

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

  const [bin, ...args] = template.trim().split(/\s+/).map(fill)
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
