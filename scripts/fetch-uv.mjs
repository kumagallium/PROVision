/**
 * uv を取得して src-tauri/binaries/ に置く（D-029）。
 *
 * 画面からの導入は uv で mflux を入れる。アプリに同梱するのは:
 *   - GUI から起動されると PATH が /usr/bin:/bin 程度で、Homebrew の uv が見えない
 *   - アプリの中から `curl | sh` を走らせたくない。何が入るかを配布側で決められない
 *
 * 置き場は Resources ではなく externalBin（`binaries/uv-<target triple>`）。
 * Resources に置いた実行ファイルは Tauri が署名せず、公証が「Developer ID で署名されて
 * いない・hardened runtime が無い」と弾く（v0.2.20 で実測）。externalBin は本体と同じ
 * 場所に置かれ、本体と同じ署名を受ける。
 *
 * 版と sha256 を固定する。上げるときは両方を書き換える（sha256 は GitHub Release の
 * `<asset>.sha256` から）。scripts/fetch-node.mjs と同じ作り。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = join(__dirname, '..')

const UV_VERSION = '0.12.9'
const SHA256 = {
  'aarch64-apple-darwin': '301f72afaf54060f92da7016cb0115bd077f43a9c8e39c1d8170a0bac80fd398',
  'x86_64-apple-darwin': 'e1ca175824f1056589ce9908f7631879ebc3c36535b5e63dc06510beb370b4c1',
  'x86_64-pc-windows-msvc': 'ddbfcee1ac615a0499f6aa97b5ec8ebdf3ee4a7714a48055ec2ba0030e3cf810',
  'aarch64-pc-windows-msvc': 'd3360363a3cb671f2c854f4ef48cf4a57fe8664f8ec6a248076d68b797a8acc0',
}
const BINARIES_DIR = join(PROJECT_ROOT, 'src-tauri', 'binaries')
/** 置いた版の目印。externalBin の glob に掛からないよう、名前を uv で始めない */
const VERSION_MARKER = join(BINARIES_DIR, '.uv-version')

const force = process.argv.includes('--force')

const isWindows = process.platform === 'win32'
const isMac = process.platform === 'darwin'
if (!isWindows && !isMac) {
  console.error(`[fetch-uv] 未対応のプラットフォーム: ${process.platform}（対応: darwin, win32）`)
  process.exit(1)
}

/** Tauri の externalBin 命名規則に合わせた host target triple（fetch-node.mjs と同じ） */
const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
const target = isMac ? `${arch}-apple-darwin` : `${arch}-pc-windows-msvc`
const exe = isWindows ? '.exe' : ''
const placed = join(BINARIES_DIR, `uv-${target}${exe}`)

const placedVersion = existsSync(VERSION_MARKER)
  ? readFileSync(VERSION_MARKER, 'utf8').trim()
  : ''
if (!force && existsSync(placed) && placedVersion === UV_VERSION) {
  console.log('[fetch-uv] 配置済み。--force で再取得します')
  process.exit(0)
}

mkdirSync(BINARIES_DIR, { recursive: true })

const ext = isWindows ? 'zip' : 'tar.gz'
const asset = `uv-${target}.${ext}`
const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${asset}`
const work = join(BINARIES_DIR, '.download-uv')

rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

console.log(`[fetch-uv] 取得: ${url}`)
const archive = join(work, asset)

// curl と tar は macOS / Windows 10+ に標準で入っている。依存を増やさない
const dl = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', archive, url], { stdio: 'inherit' })
if (dl.status !== 0) {
  console.error('[fetch-uv] ダウンロードに失敗しました')
  process.exit(1)
}

const expected = SHA256[target]
const actual = createHash('sha256').update(readFileSync(archive)).digest('hex')
if (actual !== expected) {
  console.error(`[fetch-uv] sha256 が合いません（${target}）\n  期待: ${expected}\n  実際: ${actual}`)
  rmSync(work, { recursive: true, force: true })
  process.exit(1)
}

const extract = spawnSync('tar', ['-xf', archive, '-C', work], { stdio: 'inherit' })
if (extract.status !== 0) {
  console.error('[fetch-uv] 展開に失敗しました')
  process.exit(1)
}

// macOS の tar.gz は uv-<target>/uv、Windows の zip は直下に uv.exe
const extracted = isWindows ? join(work, 'uv.exe') : join(work, `uv-${target}`, 'uv')
if (!existsSync(extracted)) {
  console.error(`[fetch-uv] 展開先に uv が見つかりません: ${extracted}`)
  process.exit(1)
}

copyFileSync(extracted, placed)
if (!isWindows) chmodSync(placed, 0o755)
writeFileSync(VERSION_MARKER, `${UV_VERSION}\n`)
rmSync(work, { recursive: true, force: true })

console.log(`[fetch-uv] 配置しました: ${placed}`)
