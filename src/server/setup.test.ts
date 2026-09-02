import { describe, expect, it } from 'vitest'
import {
  LineSplitter,
  PINNED,
  SetupRunner,
  childEnv,
  findUv,
  hasMflux,
  huggingFaceHubDir,
  recommendedQuantize,
  requiredDiskGB,
  stopOnShutdown,
  uvCandidates,
  type RunnerDeps,
  type SetupStatus,
} from './setup.js'

const HOME = '/Users/x'
const GENERATE_BIN = `${HOME}/.local/bin/mflux-generate-z-image-turbo`
const SAVE_BIN = `${HOME}/.local/bin/mflux-save`
const UV = '/opt/homebrew/bin/uv'

function statusWith(over: Partial<SetupStatus> = {}): SetupStatus {
  return {
    supported: true,
    managedByEnv: false,
    ready: false,
    uv: { found: true, brew: false },
    mflux: { found: false },
    generateModel: { found: false },
    editModel: { found: false },
    memoryGB: 24,
    recommendedQuantize: 6,
    diskFreeGB: 300,
    requiredGB: { generate: { 4: 38.5, 6: 40.9 }, edit: 32 },
    pinned: PINNED,
    job: null,
    ...over,
  }
}

type Behaviour = (
  bin: string,
  args: readonly string[],
) => { code: number | null; creates?: string[]; lines?: Array<[string, boolean]> }

/** 偽の実行環境。走ったコマンドを覚え、コマンドが「入れた」ことにするファイルを足す */
function fakeDeps(initialFiles: readonly string[], behaviour: Behaviour) {
  const files = new Set(initialFiles)
  const calls: Array<{ bin: string; args: string[]; env: NodeJS.ProcessEnv }> = []
  const renames: Array<[string, string]> = []
  const removed: string[] = []
  let readyCalls = 0
  const deps: RunnerDeps = {
    env: {},
    home: HOME,
    exists: (path) => files.has(path),
    spawnProcess: (bin, args, env, onLine) => {
      calls.push({ bin, args: [...args], env })
      const result = behaviour(bin, args)
      for (const [line, overwrite] of result.lines ?? []) onLine(line, overwrite)
      for (const created of result.creates ?? []) files.add(created)
      return { exited: Promise.resolve(result.code), kill: () => undefined }
    },
    mkdir: async () => undefined,
    remove: async (path) => {
      removed.push(path)
      files.delete(path)
    },
    rename: async (from, to) => {
      renames.push([from, to])
      files.delete(from)
      files.add(to)
    },
    dirSizeBytes: async () => 0,
    onReady: () => {
      readyCalls += 1
    },
  }
  return { deps, files, calls, renames, removed, readyCalls: () => readyCalls }
}

/** 何を頼まれても成功し、頼まれたものを置く */
const installsEverything: Behaviour = (bin, args) => {
  if (bin.endsWith('/uv')) return { code: 0, creates: [GENERATE_BIN, SAVE_BIN] }
  if (bin.endsWith('/mflux-save')) {
    const path = args[args.indexOf('--path') + 1]!
    return { code: 0, creates: [path] }
  }
  return { code: 1 }
}

describe('量子化の推奨', () => {
  it('16GB 機は 4bit、18GB 以上は 6bit（6bit のピーク 9.12GB が 16GB では残らない）', () => {
    expect(recommendedQuantize(16 * 2 ** 30)).toBe(4)
    expect(recommendedQuantize(18 * 2 ** 30)).toBe(6)
    expect(recommendedQuantize(24 * 2 ** 30)).toBe(6)
  })
})

describe('uv の探し方', () => {
  it('同梱したもの（PROVISION_UV）を最優先にし、次に手元の置き場を絶対パスで見る', () => {
    const candidates = uvCandidates({ PROVISION_UV: '/app/Resources/sidecar/uv' }, HOME)
    expect(candidates[0]).toEqual({ path: '/app/Resources/sidecar/uv', source: 'bundled' })
    expect(candidates.map((c) => c.path)).toContain(`${HOME}/.local/bin/uv`)
    expect(candidates.map((c) => c.path)).toContain('/opt/homebrew/bin/uv')
  })

  it('最初に見つかったものを返す。無ければ null', () => {
    const exists = (path: string) => path === '/opt/homebrew/bin/uv'
    expect(findUv({}, exists, HOME)).toEqual({ path: '/opt/homebrew/bin/uv', source: 'system' })
    expect(findUv({}, () => false, HOME)).toBeNull()
  })

  it('同梱したものが消えていれば、手元のものへ落ちる', () => {
    const exists = (path: string) => path === `${HOME}/.local/bin/uv`
    expect(findUv({ PROVISION_UV: '/gone/uv' }, exists, HOME)?.source).toBe('system')
  })
})

describe('必要な空き容量', () => {
  it('足りないものの分だけ足す', () => {
    expect(requiredDiskGB({ generate: true, edit: true }, { quantize: 6, editModel: false })).toBe(
      33 + 7.9,
    )
    expect(requiredDiskGB({ generate: true, edit: true }, { quantize: 4, editModel: true })).toBe(
      33 + 5.5 + 24 + 8,
    )
    expect(requiredDiskGB({ generate: false, edit: false }, { quantize: 6, editModel: true })).toBe(
      0,
    )
  })
})

describe('mflux の有無', () => {
  it('生成と保存の両方の実行ファイルが要る', () => {
    expect(hasMflux((p) => p === GENERATE_BIN, HOME)).toBe(false)
    expect(hasMflux((p) => p === GENERATE_BIN || p === SAVE_BIN, HOME)).toBe(true)
  })
})

describe('子プロセスの環境', () => {
  it('GUI 起動の空同然の PATH に、mflux と Homebrew の置き場を足す', () => {
    const env = childEnv({ PATH: '/usr/bin:/bin' }, HOME, { HOMEBREW_NO_AUTO_UPDATE: '1' })
    expect(env.PATH!.split(':')[0]).toBe(`${HOME}/.local/bin`)
    expect(env.PATH).toContain('/opt/homebrew/bin')
    expect(env.PATH!.endsWith('/usr/bin:/bin')).toBe(true)
    expect(env.UV_TOOL_BIN_DIR).toBe(`${HOME}/.local/bin`)
    expect(env.PYTHONUNBUFFERED).toBe('1')
    expect(env.HOMEBREW_NO_AUTO_UPDATE).toBe('1')
  })
})

describe('LineSplitter', () => {
  function collect(chunks: string[]) {
    const lines: Array<[string, boolean]> = []
    const splitter = new LineSplitter((line, overwrite) => lines.push([line, overwrite]))
    for (const chunk of chunks) splitter.push(chunk)
    splitter.end()
    return lines
  }

  it('改行で切る。塊の途中で切れた行も繋ぐ', () => {
    expect(collect(['a\nb', 'c\n', 'd'])).toEqual([
      ['a', false],
      ['bc', false],
      ['d', false],
    ])
  })

  it('\\r は直前の行の書き換え（進捗バーが数百行に膨らまないように）', () => {
    expect(collect(['10%\r20%\r30%\n'])).toEqual([
      ['10%', false],
      ['20%', true],
      ['30%', true],
    ])
  })

  it('塊の境目で \\r\\n が割れても、空行や書き換えにしない', () => {
    expect(collect(['x\r', '\ny'])).toEqual([
      ['x', false],
      ['y', false],
    ])
  })

  it('色の制御列と空行は捨てる。ESC の無い角括弧はそのまま', () => {
    expect(collect(['\u001b[32mdone\u001b[0m\n\n   \n'])).toEqual([['done', false]])
    expect(collect(['[notice] A new release of pip is available\n'])).toEqual([
      ['[notice] A new release of pip is available', false],
    ])
  })
})

describe('SetupRunner', () => {
  it('何も無い Mac では uv → mflux → モデルの順に走らせ、置き場の名前を最後に確定する', async () => {
    const fake = fakeDeps([UV], installsEverything)
    const runner = new SetupRunner(fake.deps)
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await runner.settled()

    const job = runner.current()!
    expect(job.status).toBe('done')
    expect(job.steps.map((s) => [s.id, s.status])).toEqual([
      ['uv', 'skipped'],
      ['mflux', 'done'],
      ['generate-model', 'done'],
    ])
    expect(fake.calls.map((c) => [c.bin, ...c.args])).toEqual([
      [
        UV,
        'tool',
        'install',
        '--python',
        PINNED.python,
        `mflux==${PINNED.mflux}`,
        '--with',
        `mlx==${PINNED.mlx}`,
      ],
      [
        SAVE_BIN,
        '--model',
        'z-image-turbo',
        '--quantize',
        '6',
        '--path',
        `${HOME}/.cache/provision/z-image-turbo-6bit.partial`,
      ],
    ])
    // 仮の名前で保存してから本来の名前へ。ここで初めて「ある」になる
    expect(fake.renames).toEqual([
      [
        `${HOME}/.cache/provision/z-image-turbo-6bit.partial`,
        `${HOME}/.cache/provision/z-image-turbo-6bit`,
      ],
    ])
    expect(fake.files.has(`${HOME}/.cache/provision/z-image-turbo-6bit`)).toBe(true)
    expect(fake.readyCalls()).toBe(1)
    // 子プロセスには GUI 起動の PATH を補った環境を渡す
    expect(fake.calls[0]!.env.UV_TOOL_BIN_DIR).toBe(`${HOME}/.local/bin`)
  })

  it('編集モデルも頼まれたら、flux2-klein-4b を 8bit で足す', async () => {
    const fake = fakeDeps([UV, GENERATE_BIN, SAVE_BIN], installsEverything)
    const runner = new SetupRunner(fake.deps)
    runner.start({ quantize: 6, editModel: true }, statusWith({ mflux: { found: true } }))
    await runner.settled()

    expect(runner.current()!.status).toBe('done')
    expect(fake.calls.map((c) => c.args.slice(0, 4))).toEqual([
      ['--model', 'z-image-turbo', '--quantize', '6'],
      ['--model', 'flux2-klein-4b', '--quantize', '8'],
    ])
    expect(fake.renames[1]).toEqual([
      `${HOME}/.cache/provision/flux2-klein-4b-q8.partial`,
      `${HOME}/.cache/provision/flux2-klein-4b-q8`,
    ])
  })

  it('揃っていれば何も走らせない。入っているものは触らない', async () => {
    const fake = fakeDeps(
      [UV, GENERATE_BIN, SAVE_BIN, `${HOME}/.cache/provision/z-image-turbo-6bit`],
      installsEverything,
    )
    const runner = new SetupRunner(fake.deps)
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await runner.settled()

    expect(runner.current()!.status).toBe('done')
    expect(runner.current()!.steps.every((s) => s.status === 'skipped')).toBe(true)
    expect(fake.calls).toEqual([])
    expect(fake.readyCalls()).toBe(1)
  })

  it('4bit があるのに 6bit を選んでも、33GB の取得を黙って始めない', async () => {
    const fake = fakeDeps(
      [UV, GENERATE_BIN, SAVE_BIN, `${HOME}/.cache/geologo/z-image-turbo-4bit`],
      installsEverything,
    )
    const runner = new SetupRunner(fake.deps)
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await runner.settled()

    const step = runner.current()!.steps.find((s) => s.id === 'generate-model')!
    expect(step.status).toBe('skipped')
    expect(step.detail).toContain('z-image-turbo-4bit')
    expect(fake.calls).toEqual([])
  })

  it('uv が無くて brew があれば brew で入れる。それも無ければ止まって理由を言う', async () => {
    const withBrew = fakeDeps(['/opt/homebrew/bin/brew'], (bin) => {
      if (bin.endsWith('/brew')) return { code: 0, creates: [UV] }
      return installsEverything(bin, [])
    })
    const runner = new SetupRunner(withBrew.deps)
    runner.start({ quantize: 4, editModel: false }, statusWith({ uv: { found: false, brew: true } }))
    await runner.settled()
    expect(withBrew.calls[0]).toMatchObject({ bin: '/opt/homebrew/bin/brew', args: ['install', 'uv'] })
    expect(withBrew.calls[0]!.env.HOMEBREW_NO_AUTO_UPDATE).toBe('1')
    expect(runner.current()!.steps[0]).toMatchObject({ id: 'uv', status: 'done' })

    const without = fakeDeps([], installsEverything)
    const bare = new SetupRunner(without.deps)
    bare.start({ quantize: 4, editModel: false }, statusWith({ uv: { found: false, brew: false } }))
    await bare.settled()
    expect(bare.current()!.status).toBe('failed')
    expect(bare.current()!.error).toContain('brew install uv')
    expect(without.calls).toEqual([])
  })

  it('保存が失敗したら半端な置き場を消し、本来の名前へ動かさない', async () => {
    const fake = fakeDeps([UV, GENERATE_BIN, SAVE_BIN], (bin, args) => {
      if (bin.endsWith('/mflux-save')) {
        return { code: 1, creates: [args[args.indexOf('--path') + 1]!], lines: [['boom', false]] }
      }
      return { code: 0 }
    })
    const runner = new SetupRunner(fake.deps)
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await runner.settled()

    const job = runner.current()!
    expect(job.status).toBe('failed')
    expect(job.error).toContain('生成モデル')
    expect(job.steps.find((s) => s.id === 'generate-model')).toMatchObject({
      status: 'failed',
      detail: '終了コード 1',
    })
    const partial = `${HOME}/.cache/provision/z-image-turbo-6bit.partial`
    expect(fake.removed.filter((p) => p === partial)).toHaveLength(2)
    expect(fake.renames).toEqual([])
    expect(fake.files.has(partial)).toBe(false)
    expect(fake.readyCalls()).toBe(0)
    expect(job.log).toContain('boom')
  })

  it('中止すると子プロセスを止め、半端な置き場を消す', async () => {
    let release: (() => void) | undefined
    const removed: string[] = []
    const deps: RunnerDeps = {
      env: {},
      home: HOME,
      exists: (path) => [UV, GENERATE_BIN, SAVE_BIN].includes(path),
      spawnProcess: () => ({
        exited: new Promise<number | null>((resolve) => {
          release = () => resolve(null)
        }),
        kill: () => release?.(),
      }),
      mkdir: async () => undefined,
      remove: async (path) => {
        removed.push(path)
      },
      rename: async () => undefined,
      dirSizeBytes: async () => 0,
    }
    const runner = new SetupRunner(deps)
    runner.start({ quantize: 6, editModel: false }, statusWith())
    // plan() は非同期なので、spawn まで進ませてから止める
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runner.cancel()).toBe(true)
    await runner.settled()

    const job = runner.current()!
    expect(job.status).toBe('cancelled')
    expect(job.steps.find((s) => s.id === 'generate-model')).toMatchObject({
      status: 'failed',
      detail: '中止した',
    })
    expect(removed).toContain(`${HOME}/.cache/provision/z-image-turbo-6bit.partial`)
    // 走っていないときの中止は何もしない
    expect(runner.cancel()).toBe(false)
  })

  it('plan() の最中に中止されたら、その段階のコマンドを走らせない', async () => {
    let spawned = 0
    const runner = new SetupRunner({
      env: {},
      home: HOME,
      exists: (path) => [UV, GENERATE_BIN, SAVE_BIN].includes(path),
      spawnProcess: () => {
        spawned += 1
        return { exited: Promise.resolve(0), kill: () => undefined }
      },
      mkdir: async () => undefined,
      // 段階の準備（半端の削除）の途中で中止が来る
      remove: async () => {
        runner.cancel()
      },
      rename: async () => undefined,
      dirSizeBytes: async () => 0,
    })
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await runner.settled()
    expect(spawned).toBe(0)
    expect(runner.current()!.status).toBe('cancelled')
  })

  it('進捗バーの書き換えは直前の出力だけに効き、目印の行は残る', async () => {
    const fake = fakeDeps([UV, GENERATE_BIN, SAVE_BIN], (bin, args) => {
      if (bin.endsWith('/mflux-save')) {
        return {
          code: 0,
          creates: [args[args.indexOf('--path') + 1]!],
          lines: [
            ['10%', true],
            ['20%', true],
            ['saved', false],
          ],
        }
      }
      return { code: 0 }
    })
    const runner = new SetupRunner(fake.deps)
    runner.start({ quantize: 4, editModel: false }, statusWith())
    await runner.settled()

    const log = runner.current()!.log
    expect(log[0]).toMatch(/^▶ mflux-save --model z-image-turbo --quantize 4/)
    expect(log.slice(1, 3)).toEqual(['20%', 'saved'])
  })

  it('取得中は Hugging Face のキャッシュの大きさを段階の説明に出し、終われば置き場に置き換わる', async () => {
    let release: (() => void) | undefined
    const measured: string[] = []
    const runner = new SetupRunner({
      env: {},
      home: HOME,
      exists: (path) => [UV, GENERATE_BIN, SAVE_BIN].includes(path),
      spawnProcess: () => ({
        exited: new Promise<number | null>((resolve) => {
          release = () => resolve(0)
        }),
        kill: () => undefined,
      }),
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
      dirSizeBytes: async (path) => {
        measured.push(path)
        return 2.5 * 2 ** 30
      },
      progressIntervalMs: 1,
    })
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await new Promise((resolve) => setTimeout(resolve, 10))

    const running = runner.current()!.steps.find((s) => s.id === 'generate-model')!
    expect(running.status).toBe('running')
    expect(running.detail).toBe('取得 2.5 / 約 33GB')
    expect(measured[0]).toBe(`${HOME}/.cache/huggingface/hub/models--Tongyi-MAI--Z-Image-Turbo`)

    release!()
    await runner.settled()
    const done = runner.current()!.steps.find((s) => s.id === 'generate-model')!
    expect(done).toMatchObject({ status: 'done', detail: '~/.cache/provision/z-image-turbo-6bit' })
  })

  it('始められない理由は始める前に言う', () => {
    const runner = new SetupRunner(fakeDeps([UV], installsEverything).deps)
    const options = { quantize: 6 as const, editModel: false }
    expect(() => runner.start(options, statusWith({ supported: false }))).toThrow()
    expect(() => runner.start(options, statusWith({ managedByEnv: true }))).toThrow(
      /PROVISION_IMAGE_COMMAND/,
    )
    expect(() => runner.start(options, statusWith({ diskFreeGB: 20 }))).toThrow(/空き容量/)
    // 揃っているものの分は数えないので、空きが少なくても始められる
    expect(() =>
      runner.start(options, statusWith({ diskFreeGB: 1, generateModel: { found: true } })),
    ).not.toThrow()
    // 走っている間は 2 本目を受けない
    expect(() => runner.start(options, statusWith())).toThrow(/進んでいる/)
  })
})

describe('huggingFaceHubDir', () => {
  it('利用者が置き場を変えていればそれに従う', () => {
    expect(huggingFaceHubDir({}, HOME)).toBe(`${HOME}/.cache/huggingface/hub`)
    expect(huggingFaceHubDir({ HF_HOME: '/Volumes/big/hf' }, HOME)).toBe('/Volumes/big/hf/hub')
    expect(huggingFaceHubDir({ HF_HOME: '/x', HF_HUB_CACHE: '/y/hub' }, HOME)).toBe('/y/hub')
  })
})

describe('stopOnShutdown', () => {
  it('シグナルで子プロセスを止めてから、既定と同じ終了コードで exit する', async () => {
    let release: (() => void) | undefined
    let killed = 0
    const runner = new SetupRunner({
      env: {},
      home: HOME,
      exists: (path) => [UV, GENERATE_BIN, SAVE_BIN].includes(path),
      spawnProcess: () => ({
        exited: new Promise<number | null>((resolve) => {
          release = () => resolve(null)
        }),
        kill: () => {
          killed += 1
          release?.()
        },
      }),
      mkdir: async () => undefined,
      remove: async () => undefined,
      rename: async () => undefined,
      dirSizeBytes: async () => 0,
    })
    const handlers = new Map<string, () => void>()
    const exits: number[] = []
    const proc = {
      once: (signal: string, handler: () => void) => {
        handlers.set(signal, handler)
      },
      exit: (code: number) => {
        exits.push(code)
      },
    } as unknown as NodeJS.Process
    stopOnShutdown(runner, proc)
    runner.start({ quantize: 6, editModel: false }, statusWith())
    await new Promise((resolve) => setTimeout(resolve, 0))

    handlers.get('SIGTERM')!()
    expect(killed).toBe(1)
    expect(exits).toEqual([143])
  })
})
