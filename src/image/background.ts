import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from '../prov/sha256.js'
import type { GenerateResult } from './mflux.js'

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

export function resolveBackgroundRemovalCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.PROVISION_BACKGROUND_COMMAND?.trim()
  if (configured) {
    if (!configured.includes('{image}') || !configured.includes('{out}')) {
      throw new Error('背景透明化コマンドに {image} と {out} が必要です')
    }
    return configured
  }
  const bin = join(homedir(), '.local', 'bin', 'rembg')
  if (existsSync(bin)) return `${bin} i {image} {out}`
  throw new Error(
    '背景を透明化するにはrembgが必要です。' +
      '`uv tool install --python 3.11 "rembg[cpu,cli]"` を実行してください',
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
  return executable === 'rembg'
    ? 'u2net'
    : `custom-${sha256(template).slice(0, 12)}`
}
