import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from '../prov/sha256.js'
import { ToolMissingError } from './tool-missing.js'

const execFileAsync = promisify(execFile)

export interface InpaintInput {
  imagePath: string
  imageDigest: string
  maskPath: string
  maskDigest: string
}

export interface InpaintResult {
  png: Uint8Array
  model: string
  provider: string
  startedAtTime: string
  endedAtTime: string
}

export function inpaintCacheKeyOf(input: InpaintInput, model = 'big-lama'): string {
  return sha256([input.imageDigest, input.maskDigest, model].join('\u0000')).slice(0, 32)
}

export function suggestInpaintCommand(
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string | null {
  const bin = join(home, '.local', 'bin', 'iopaint')
  if (!exists(bin)) return null
  const device = process.arch === 'arm64' ? 'mps' : 'cpu'
  return [
    bin,
    'run',
    '--model lama',
    `--device ${device}`,
    '--image {image}',
    '--mask {mask}',
    '--output {outputDir}',
  ].join(' ')
}

export function resolveInpaintCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROVISION_INPAINT_COMMAND?.trim()
  const template = configured || suggestInpaintCommand()
  if (!template) {
    throw new ToolMissingError(
      '選択範囲を自然に消すには LaMa（IOPaint）が要ります。設定の「画像生成」から入れられます' +
        '（自分で入れるなら `uv tool install --python 3.10 iopaint`）',
    )
  }
  for (const placeholder of ['{image}', '{mask}']) {
    if (!template.includes(placeholder)) {
      throw new Error(`inpaintingコマンドに ${placeholder} が必要です`)
    }
  }
  if (!template.includes('{out}') && !template.includes('{outputDir}')) {
    throw new Error('inpaintingコマンドに {out} または {outputDir} が必要です')
  }
  return template
}

export async function inpaintImage(input: InpaintInput): Promise<InpaintResult> {
  if (!existsSync(input.imagePath)) {
    throw new Error(`編集元の画像が見つかりません: ${input.imagePath}`)
  }
  if (!existsSync(input.maskPath)) {
    throw new Error(`編集範囲のマスクが見つかりません: ${input.maskPath}`)
  }

  const template = resolveInpaintCommand()
  const dir = await mkdtemp(join(tmpdir(), 'provision-inpaint-'))
  const outputDir = join(dir, 'output')
  const out = join(dir, 'inpainted.png')
  await mkdir(outputDir)

  const fill = (value: string) =>
    value
      .replaceAll('{image}', input.imagePath)
      .replaceAll('{mask}', input.maskPath)
      .replaceAll('{out}', out)
      .replaceAll('{outputDir}', outputDir)

  const args = template.trim().split(/\s+/).map(fill)
  const [bin] = args.splice(0, 1)
  const startedAtTime = new Date().toISOString()
  try {
    await execFileAsync(bin!, args, { maxBuffer: 64 * 1024 * 1024 })
    const generated = existsSync(out) ? out : join(outputDir, basename(input.imagePath))
    if (!existsSync(generated)) {
      throw new Error('inpaintingコマンドが出力PNGを作りませんでした')
    }
    return {
      png: new Uint8Array(await readFile(generated)),
      model: 'big-lama',
      provider: `command:${bin!.split('/').pop()}`,
      startedAtTime,
      endedAtTime: new Date().toISOString(),
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    throw new Error(`LaMaによる範囲編集に失敗しました: ${why}`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
