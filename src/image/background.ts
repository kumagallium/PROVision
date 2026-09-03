import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from '../prov/sha256.js'
import type { GenerateResult } from './mflux.js'
import { ToolMissingError } from './tool-missing.js'

const execFileAsync = promisify(execFile)

export interface BackgroundRemovalInput {
  imagePath: string
  imageDigest: string
  command?: string
}

export function backgroundRemovalCacheKeyOf(input: BackgroundRemovalInput): string {
  const command = input.command ?? resolveBackgroundRemovalCommand()
  return sha256(['background.remove', input.imageDigest, command].join('\u0000')).slice(0, 32)
}

/**
 * 使うモデルを**名指しする**。rembg の既定は版で変わり、2.0.83 では
 * bria-rmbg（1.02GB・非商用ライセンス）になっていた——**黙って別のモデルで走り**、
 * 来歴には `rembg (U²-Net)` と書かれる（実測）。名指しすれば、記録と実物が一致する。
 * U²-Net は Apache-2.0 で、176MB で済む。
 */
export const BACKGROUND_MODEL = 'u2net'

export function resolveBackgroundRemovalCommand(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): string {
  const configured = env.PROVISION_BACKGROUND_COMMAND?.trim()
  if (configured) {
    if (!configured.includes('{image}') || !configured.includes('{out}')) {
      throw new Error('背景透明化コマンドに {image} と {out} が必要です')
    }
    return configured
  }
  const bin = join(home, '.local', 'bin', 'rembg')
  if (exists(bin)) return `${bin} i -m ${BACKGROUND_MODEL} {image} {out}`
  throw new ToolMissingError(
    '背景を透明化するには rembg が要ります。設定の「画像生成」から入れられます' +
      '（自分で入れるなら `uv tool install --python 3.11 "rembg[cpu,cli]"`）',
  )
}

export async function removeBackground(
  input: BackgroundRemovalInput,
): Promise<GenerateResult> {
  if (!existsSync(input.imagePath)) {
    throw new Error(`編集元の画像が見つかりません: ${input.imagePath}`)
  }
  const template = input.command ?? resolveBackgroundRemovalCommand()
  const dir = await mkdtemp(join(tmpdir(), 'provision-background-'))
  const out = join(dir, 'transparent.png')
  const args = template
    .trim()
    .split(/\s+/)
    .map((arg) => arg.replaceAll('{image}', input.imagePath).replaceAll('{out}', out))
  const [bin] = args.splice(0, 1)
  const startedAtTime = new Date().toISOString()
  try {
    await execFileAsync(bin!, args, { maxBuffer: 64 * 1024 * 1024 })
    if (!existsSync(out)) throw new Error('rembgが出力PNGを作りませんでした')
    return {
      png: new Uint8Array(await readFile(out)),
      model: backgroundRemovalModelOf(template),
      provider: `command:${bin!.split('/').pop()}`,
      startedAtTime,
      endedAtTime: new Date().toISOString(),
    }
  } catch (error) {
    throw new Error(
      `背景透明化に失敗しました: ${error instanceof Error ? error.message : String(error)}`,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

export function backgroundRemovalModelOf(template: string): string {
  const explicit = /(?:--model|-m)\s+(\S+)/.exec(template)?.[1]
  if (explicit) return explicit
  const executable = template.trim().split(/\s+/)[0]?.split('/').pop()
  /**
   * 名指ししていない rembg は、**その版の既定**で走る。かつて u2net と決め打っていたが、
   * 2.0.83 の既定は bria-rmbg だった（実測）——決め打つと記録が嘘になる。
   * 既定が何であるかは版に依るので、そう書く（こちらの既定コマンドは必ず名指しする）
   */
  return executable === 'rembg'
    ? 'rembg-default'
    : `custom-${sha256(template).slice(0, 12)}`
}
