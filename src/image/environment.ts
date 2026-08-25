/**
 * 実行環境を実測する（D-015）。
 *
 * 別の PC で同じ指定を出したのに違う絵が出たとき、**どこが違ったか**を
 * 特定するための情報を集める。ビット一致を保証するためではない——
 * 拡散モデル＋Metal ではそこへ行けないと決めてある。
 *
 * 原則: **取れなかったものは載せない。** 推定値やそれらしい既定値を書くと、
 * 「調べたが無い」と「そもそも調べていない」が区別できなくなり、
 * 食い違いの原因究明という唯一の目的が潰れる。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { sha256 } from '../prov/sha256.js'

const execFileAsync = promisify(execFile)

/** 版の問い合わせは起動を待たせる。応答しないコマンドは諦める */
const PROBE_TIMEOUT_MS = 4000

/**
 * 出力から版番号らしい部分だけを取り出す。
 * `--version` の出力は「mflux 0.9.1」「iopaint, version 1.6.0」などまちまちで、
 * 全文を載せるとバナーや警告まで来歴に混ざる。
 */
export function parseVersion(output: string): string | undefined {
  const match = /\d+\.\d+(?:\.\d+)*(?:[-.][0-9A-Za-z]+)*/.exec(output)
  return match ? match[0] : undefined
}

/**
 * モデル重みの指紋。**ファイル名とサイズから取る。中身は数えない。**
 *
 * 重み全体を sha256 に通すと起動のたびに十数秒かかる。狙いは
 * 「同名のまま中身が差し替わった」の検出なので、名前とサイズで足りる。
 * 中身のハッシュだと名乗らないのは、名前が実態より強い主張をしないため（D-010）。
 */
export function fingerprintOf(entries: ReadonlyArray<{ path: string; size: number }>): string {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha256(sorted.map((e) => `${e.path}:${e.size}`).join(' ')).slice(0, 32)
}

/** ディレクトリ配下のファイルを名前とサイズだけ集める。無ければ undefined */
export async function probeModelFingerprint(dir: string): Promise<string | undefined> {
  if (!existsSync(dir)) return undefined
  const entries: { path: string; size: number }[] = []
  const walk = async (current: string, prefix: string): Promise<void> => {
    const names = await readdir(current, { withFileTypes: true })
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name.name}` : name.name
      const full = join(current, name.name)
      if (name.isDirectory()) {
        await walk(full, rel)
      } else if (name.isFile()) {
        entries.push({ path: rel, size: (await stat(full)).size })
      }
    }
  }
  try {
    await walk(dir, '')
  } catch {
    return undefined
  }
  return entries.length > 0 ? fingerprintOf(entries) : undefined
}

/**
 * コマンドテンプレートから実行ファイルを取り出す。
 * 版の問い合わせ先はここで、`--model` などの引数は付けない。
 */
export function binaryOf(template: string): string {
  return template.trim().split(/\s+/)[0] ?? ''
}

/**
 * テンプレートの `--model` がローカルの置き場を指しているときだけ、その場所を返す。
 * `flux2-klein-4b` のような識別子は場所ではないので指紋を取りようがなく、
 * そこは `provision:model` の文字列に任せる。
 */
export function modelPathOf(template: string): string | undefined {
  const value = /--model\s+(\S+)/.exec(template)?.[1]
  return value && value.startsWith('/') ? value : undefined
}

/**
 * コマンドの版を問い合わせる。**落ちても投げない**——
 * 版が取れないことは生成を止める理由にならない。
 */
export async function probeCommandVersion(
  bin: string,
  args: readonly string[] = ['--version'],
): Promise<string | undefined> {
  if (!bin) return undefined
  try {
    const { stdout, stderr } = await execFileAsync(bin, [...args], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    })
    // 版を stderr に出すツールがある（Python 系に多い）
    return parseVersion(stdout) ?? parseVersion(stderr)
  } catch {
    return undefined
  }
}

/**
 * パッケージ名を PEP 503 の正規形へ。`IOPaint` と `iopaint`、
 * `python_dateutil` と `python-dateutil` を同じものとして扱うため。
 */
function normalizePackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-')
}

/**
 * `uv tool install` で入れた Python ツールの版を、**プロセスを起動せずに**読む。
 *
 * mflux も iopaint も rembg も `--version` を持っていない（実測。exit 0 で
 * 何も出さないか、生成を始めてしまう）。一方 uv の置き場は
 * `<root>/tools/<name>/lib/python<版>/site-packages/<pkg>-<version>.dist-info`
 * という決まった形をしているので、そこを読めば起動しなくても版が分かる。
 *
 * `names` に道連れのパッケージも渡せる。**mflux では mlx の版が本命**で、
 * 別 PC でビットがずれるかどうかは mflux 本体より mlx に効く（D-015）。
 */
export async function probeInstalledVersions(
  bin: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  if (!bin || names.length === 0) return {}
  try {
    // ~/.local/bin/<cmd> は <root>/tools/<name>/bin/<cmd> への symlink
    const real = await realpath(bin)
    const toolRoot = dirname(dirname(real))
    const lib = join(toolRoot, 'lib')
    const pythons = await readdir(lib)
    const wanted = new Set(names.map(normalizePackageName))
    const found: Record<string, string> = {}
    for (const python of pythons) {
      let entries: string[]
      try {
        entries = await readdir(join(lib, python, 'site-packages'))
      } catch {
        continue
      }
      for (const entry of entries) {
        const m = /^(.+?)-(\d[^-]*)\.dist-info$/.exec(entry)
        if (!m) continue
        const name = normalizePackageName(m[1]!)
        if (wanted.has(name)) found[name] = m[2]!
      }
    }
    return found
  } catch {
    return {}
  }
}

/**
 * ホームディレクトリを `~` に畳む。
 *
 * 書き出した JSON-LD は外部のビューアへ貼る前提なので、そこに利用者名を混ぜない。
 * ついでに**別 PC との突き合わせが効くようになる**——利用者名が違うだけで
 * 「コマンドが違う」と出ていては、差分を見る意味が無い。
 */
export function normalizeHome(value: string, home: string = homedir()): string {
  if (!home) return value
  return value.split(home).join('~')
}

/**
 * uv の置き場から Python の版を読む（`lib/python3.13` から `3.13`）。
 * 依存の解決が変わりうるので、これも食い違いの容疑者に入る。
 */
export async function probePythonVersion(bin: string): Promise<string | undefined> {
  if (!bin) return undefined
  try {
    const toolRoot = dirname(dirname(await realpath(bin)))
    const found = (await readdir(join(toolRoot, 'lib')))
      .map((name) => /^python(\d+\.\d+)$/.exec(name)?.[1])
      .filter((v): v is string => v !== undefined)
      .sort()
    return found[0]
  } catch {
    return undefined
  }
}

/** `mflux 0.18.1, mlx 0.31.2` の形へ。順は names に従うので、環境が同じなら文字列も同じ */
export function formatVersions(
  versions: Record<string, string>,
  names: readonly string[],
): string | undefined {
  const parts = names
    .map((n) => [n, versions[normalizePackageName(n)]] as const)
    .filter((pair): pair is readonly [string, string] => pair[1] !== undefined)
    .map(([name, version]) => `${name} ${version}`)
  return parts.length > 0 ? parts.join(', ') : undefined
}

/**
 * チップと OS。
 *
 * **機種識別子だけでは足りない。** `MacBookPro18,2` は M1 Max の 24 コア GPU と
 * 32 コア GPU の両方を指す（BTO の差を吸収してしまう）。コア数が変われば
 * スレッドグループ分割が変わり、浮動小数点の集約順序が変わる——D-015 で
 * 「別 PC では一致しない」と言っている当のものなので、コア数は別に採る。
 *
 * OS も製品版だけでは足りない。同じ 26.5.1 でもビルドが違えば Metal の
 * カーネル実装が変わりうるので、ビルド番号まで残す。
 */
export function describePlatform(parts: {
  hardwareModel?: string
  cpuBrand?: string
  gpuCores?: number
  osName: string
  osVersion?: string
  osBuild?: string
}): string {
  const os = [parts.osName, parts.osVersion, parts.osBuild ? `(${parts.osBuild})` : undefined]
    .filter(Boolean)
    .join(' ')
  return [
    parts.hardwareModel,
    parts.cpuBrand,
    parts.gpuCores !== undefined ? `GPU ${parts.gpuCores}-core` : undefined,
    os,
  ]
    .filter((v) => v && String(v).trim())
    .join(' / ')
}

/**
 * GPU のコア数。`sysctl` には出ないので IORegistry から読む。
 * 取れなければ諦める——推測は書かない。
 */
export function parseGpuCoreCount(ioregOutput: string): number | undefined {
  const m = /"gpu-core-count"\s*=\s*(\d+)/.exec(ioregOutput)
  return m ? Number(m[1]) : undefined
}

/** この Mac の機種・チップ・OS を実測する。取れない項目は落とす */
export async function probePlatform(): Promise<string | undefined> {
  // 他 OS では実測手段を用意していない。推測は書かない
  if (process.platform !== 'darwin') return undefined

  const run = async (bin: string, args: readonly string[]): Promise<string | undefined> => {
    try {
      const { stdout } = await execFileAsync(bin, [...args], { timeout: PROBE_TIMEOUT_MS })
      return stdout.trim() || undefined
    } catch {
      return undefined
    }
  }

  // `ioreg -l` は 1MB を超えて既定の maxBuffer に当たる。GPU のノードだけ引く（実測 44KB）
  const ioreg = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'AGXAccelerator', '-w0'])
  const described = describePlatform({
    hardwareModel: await run('/usr/sbin/sysctl', ['-n', 'hw.model']),
    cpuBrand: await run('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    gpuCores: ioreg ? parseGpuCoreCount(ioreg) : undefined,
    osName: 'macOS',
    osVersion: await run('/usr/bin/sw_vers', ['-productVersion']),
    osBuild: await run('/usr/bin/sw_vers', ['-buildVersion']),
  })
  return described.trim() ? described : undefined
}
