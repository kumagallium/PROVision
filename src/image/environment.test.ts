import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  binaryOf,
  describePlatform,
  fingerprintOf,
  formatVersions,
  modelPathOf,
  normalizeHome,
  parseGpuCoreCount,
  parseVersion,
  probeInstalledVersions,
  probePythonVersion,
} from './environment.js'

describe('parseVersion', () => {
  it('ツールごとにばらばらな --version の出力から版だけ取る', () => {
    expect(parseVersion('mflux 0.9.1')).toBe('0.9.1')
    expect(parseVersion('iopaint, version 1.6.0')).toBe('1.6.0')
    expect(parseVersion('rembg 2.0.57\n')).toBe('2.0.57')
  })

  it('前置きの警告に数字が無ければ、版の行まで読み飛ばす', () => {
    expect(parseVersion('WARNING: something\nmflux 0.9.1')).toBe('0.9.1')
  })

  it('版が読めなければ undefined。それらしい値を捏造しない（D-015）', () => {
    expect(parseVersion('')).toBeUndefined()
    expect(parseVersion('unknown')).toBeUndefined()
  })
})

describe('fingerprintOf', () => {
  it('並び順が違っても同じ指紋になる。readdir の順に依存させない', () => {
    const a = fingerprintOf([
      { path: 'b.safetensors', size: 2 },
      { path: 'a.json', size: 1 },
    ])
    const b = fingerprintOf([
      { path: 'a.json', size: 1 },
      { path: 'b.safetensors', size: 2 },
    ])
    expect(a).toBe(b)
  })

  it('サイズが変われば指紋も変わる。同名のまま重みが差し替わったのを見つけるため', () => {
    const before = fingerprintOf([{ path: 'model.safetensors', size: 100 }])
    const after = fingerprintOf([{ path: 'model.safetensors', size: 101 }])
    expect(before).not.toBe(after)
  })
})

describe('binaryOf / modelPathOf', () => {
  const template =
    '/Users/x/.local/bin/mflux-generate-z-image-turbo --model /Users/x/.cache/z-image-turbo-4bit --output {out}'

  it('版の問い合わせ先は実行ファイルだけで、引数は付けない', () => {
    expect(binaryOf(template)).toBe('/Users/x/.local/bin/mflux-generate-z-image-turbo')
  })

  it('--model がローカルの置き場なら、そこの指紋を取れる', () => {
    expect(modelPathOf(template)).toBe('/Users/x/.cache/z-image-turbo-4bit')
  })

  it('--model が識別子なら場所ではないので undefined。provision:model に任せる', () => {
    expect(modelPathOf('/bin/mflux-generate-flux2-edit --model flux2-klein-4b')).toBeUndefined()
  })
})

describe('describePlatform', () => {
  it('GPU コア数とビルド番号まで残す。機種識別子は BTO の差を吸収してしまう（D-015）', () => {
    expect(
      describePlatform({
        hardwareModel: 'MacBookPro18,2',
        cpuBrand: 'Apple M1 Max',
        gpuCores: 32,
        osName: 'macOS',
        osVersion: '26.5.1',
        osBuild: '25F80',
      }),
    ).toBe('MacBookPro18,2 / Apple M1 Max / GPU 32-core / macOS 26.5.1 (25F80)')
  })

  it('取れなかった項目は落とす。空欄を作らない', () => {
    expect(describePlatform({ cpuBrand: 'Apple M1', osName: 'macOS' })).toBe('Apple M1 / macOS')
  })
})

describe('formatVersions', () => {
  it('names の順に並べる。環境が同じなら文字列も同じになる（Agent の slug に使う）', () => {
    const versions = { mflux: '0.18.1', mlx: '0.31.2' }
    expect(formatVersions(versions, ['mflux', 'mlx'])).toBe('mflux 0.18.1, mlx 0.31.2')
  })

  it('大文字小文字が違っても同じパッケージとして引ける（IOPaint / iopaint）', () => {
    expect(formatVersions({ iopaint: '1.6.0' }, ['IOPaint'])).toBe('IOPaint 1.6.0')
  })

  it('取れなかったものは並べない。1 つも無ければ undefined', () => {
    expect(formatVersions({ mflux: '0.18.1' }, ['mflux', 'mlx'])).toBe('mflux 0.18.1')
    expect(formatVersions({}, ['mflux'])).toBeUndefined()
  })
})

describe('probeInstalledVersions', () => {
  it('uv の置き場から、起動せずに版を読む（--version を持たないツール向け）', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provision-env-'))
    const site = join(root, 'tools', 'mflux', 'lib', 'python3.13', 'site-packages')
    await mkdir(site, { recursive: true })
    await mkdir(join(root, 'tools', 'mflux', 'bin'), { recursive: true })
    const bin = join(root, 'tools', 'mflux', 'bin', 'mflux-generate-z-image-turbo')
    await writeFile(bin, '')
    for (const name of ['mflux-0.18.1', 'mlx-0.31.2', 'numpy-2.5.2']) {
      await mkdir(join(site, `${name}.dist-info`), { recursive: true })
    }

    try {
      const found = await probeInstalledVersions(bin, ['mflux', 'mlx'])
      // 頼んでいない numpy は返さない。来歴を依存関係一覧で埋めない
      expect(found).toEqual({ mflux: '0.18.1', mlx: '0.31.2' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('置き場が uv の形をしていなければ空。推測で埋めない（D-015）', async () => {
    expect(await probeInstalledVersions('/nonexistent/bin/whatever', ['mflux'])).toEqual({})
    expect(await probeInstalledVersions('', ['mflux'])).toEqual({})
  })
})

describe('parseGpuCoreCount', () => {
  it('IORegistry の出力からコア数を取る', () => {
    expect(parseGpuCoreCount('  | |   "gpu-core-count" = 32\n')).toBe(32)
  })

  it('無ければ undefined。既定値で埋めない（D-015）', () => {
    expect(parseGpuCoreCount('"other-key" = 1')).toBeUndefined()
    expect(parseGpuCoreCount('')).toBeUndefined()
  })
})

describe('normalizeHome', () => {
  it('ホームを ~ に畳む。書き出したファイルに利用者名を混ぜない', () => {
    expect(
      normalizeHome('/Users/alice/.local/bin/mflux --model /Users/alice/.cache/m', '/Users/alice'),
    ).toBe('~/.local/bin/mflux --model ~/.cache/m')
  })

  it('利用者名が違うだけの 2 台を、同じコマンドとして突き合わせられる', () => {
    const a = normalizeHome('/Users/alice/.local/bin/mflux --steps 8', '/Users/alice')
    const b = normalizeHome('/Users/bob/.local/bin/mflux --steps 8', '/Users/bob')
    expect(a).toBe(b)
  })

  it('ホームが空なら何もしない', () => {
    expect(normalizeHome('/opt/mflux', '')).toBe('/opt/mflux')
  })
})

describe('probePythonVersion', () => {
  it('uv の置き場のディレクトリ名から Python の版を読む', async () => {
    const root = await mkdtemp(join(tmpdir(), 'provision-py-'))
    await mkdir(join(root, 'tools', 'mflux', 'lib', 'python3.13'), { recursive: true })
    await mkdir(join(root, 'tools', 'mflux', 'bin'), { recursive: true })
    const bin = join(root, 'tools', 'mflux', 'bin', 'mflux-generate')
    await writeFile(bin, '')
    try {
      expect(await probePythonVersion(bin)).toBe('3.13')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('置き場が uv の形でなければ undefined', async () => {
    expect(await probePythonVersion('/nonexistent/bin/x')).toBeUndefined()
  })
})
