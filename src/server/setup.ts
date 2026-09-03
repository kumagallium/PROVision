/**
 * 画像生成環境の導入（D-029）。uv → mflux → 量子化済みモデルの順に、**足りないものだけ**足す。
 *
 * 初めての Mac でまず出るのが「画像生成コマンドが見つからない」で、そこから README を
 * 探して 3 つのコマンドを打つのが最初の体験になっていた。しかも README には mflux 本体の
 * 入れ方が書かれていなかった。画面のボタン 1 つで済むようにする。
 *
 * ここに置いた判断:
 *   - **版は固定する。** mflux と mlx の版が違えば絵が変わりうる（D-015）。
 *     「最新を入れる」導入は、Mac ごとに違う環境を静かに作る
 *   - **入っているものは触らない。** 既にある mflux を入れ替えたり、モデルを置き直したり
 *     しない。手で整えた環境を壊さないため
 *   - **途中で止まっても半端なものを残さない。** モデルは仮の名前で保存し、終わってから
 *     本来の名前へ動かす。半端なディレクトリを「ある」と見なすと、生成が黙って落ちる
 *   - **サーバと運命を共にする。** アプリが終われば子プロセスも止める。
 *     取りかけの download は Hugging Face 側が続きから再開できる
 *
 * `index.ts` から切り出してあるのは、あちらが import した時点でサーバを起動するため。
 * 実行（spawn）とファイル操作は差し替えられる形にし、テストは偽物で回す。
 */
import { spawn } from 'node:child_process'
import { existsSync, type Dirent } from 'node:fs'
import { mkdir, readdir, rename, rm, stat, statfs, writeFile } from 'node:fs/promises'
import { homedir, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import {
  EDIT_MODEL_DIR,
  MODEL_DIRS_BEST_FIRST,
  findSavedModel,
  uvToolBinPath,
  resolveImageCommand,
} from '../image/mflux.js'
import { BACKGROUND_MODEL } from '../image/background.js'
import { suggestInpaintCommand } from '../image/lama.js'
import { normalizeHome } from '../image/environment.js'
import { probeToolEnvironment } from './agents.js'

/**
 * 固定する版。README の実測（D-015 の突き合わせ）と同じ組み合わせにする。
 * mflux 0.18.1 は mlx<0.32 を要求するので、mlx は 0.31 系の最終。
 * 上げるときは README の実測表と一緒に上げる。
 */
export const PINNED = {
  python: '3.13',
  mflux: '0.18.1',
  mlx: '0.31.2',
  /** 範囲の消去（LaMa / IOPaint）。python は iopaint 側の要求に合わせる */
  inpaintPython: '3.10',
  iopaint: '1.6.0',
  /** 背景の透明化。**モデルも固定する**——rembg の既定は版で変わる（background.ts） */
  backgroundPython: '3.11',
  rembg: '2.0.83',
} as const

export type Quantize = 4 | 6

export interface SetupOptions {
  quantize: Quantize
  /** 編集特化モデル（flux2-klein-4b の 8bit 保存）も置くか */
  editModel: boolean
  /** 範囲の消去（LaMa / IOPaint）も入れるか */
  inpaint?: boolean
  /** 背景の透明化（rembg / U²-Net）も入れるか */
  background?: boolean
}

export type StepId =
  | 'uv'
  | 'mflux'
  | 'generate-model'
  | 'edit-model'
  | 'inpaint'
  | 'inpaint-model'
  | 'background'
  | 'background-model'
export type StepStatus = 'pending' | 'running' | 'done' | 'skipped' | 'failed'

export interface StepState {
  id: StepId
  label: string
  status: StepStatus
  detail?: string
}

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled'

export interface JobState {
  status: JobStatus
  options: SetupOptions
  steps: StepState[]
  /** 子プロセスの出力の末尾。進捗バーは 1 行を書き換え続ける（端末と同じ見え方） */
  log: string[]
  startedAt: string
  endedAt?: string
  error?: string
}

export interface UvLocation {
  path: string
  /** アプリに同梱したもの（PROVISION_UV）か、この Mac に元からあるものか */
  source: 'bundled' | 'system'
}

export interface SetupStatus {
  /** ここからの導入ができる環境か（Apple Silicon の macOS だけ） */
  supported: boolean
  unsupportedReason?: string
  /** PROVISION_IMAGE_COMMAND で指されている。利用者が自分で管理しているので触らない */
  managedByEnv: boolean
  /** いま生成できるか（コマンドが解決できるか） */
  ready: boolean
  commandTemplate?: string
  uv: { found: boolean; path?: string; source?: UvLocation['source']; brew: boolean }
  mflux: { found: boolean; versions?: string }
  generateModel: { found: boolean; path?: string }
  editModel: { found: boolean; path?: string }
  /** 範囲の消去（LaMa / IOPaint）。任意 */
  inpaint: { found: boolean; versions?: string }
  /** 背景の透明化（rembg / U²-Net）。任意 */
  background: { found: boolean; versions?: string }
  memoryGB: number
  recommendedQuantize: Quantize
  diskFreeGB?: number
  /** 各要素を入れるのに要る空き（GB）。画面は選んだ組み合わせで足し合わせる */
  requiredGB: { generate: Record<Quantize, number>; edit: number; inpaint: number; background: number }
  pinned: typeof PINNED
  job: JobState | null
}

/**
 * 元モデルの大きさ（GB）。Hugging Face の公開リポジトリの合計（実測: Z-Image-Turbo 32.9GB、
 * FLUX.2-klein-4B 23.7GB）。落としてから量子化するので、保存分（README の実測表）も要る。
 */
const DOWNLOAD_GB = { 'z-image-turbo': 33, 'flux2-klein-4b': 24 } as const
/** mflux が落としに行く先。取得の進み具合はこのキャッシュの大きさで測る */
const HF_REPO = {
  'z-image-turbo': 'Tongyi-MAI/Z-Image-Turbo',
  'flux2-klein-4b': 'black-forest-labs/FLUX.2-klein-4B',
} as const

/** Hugging Face のキャッシュ（hub）。利用者が置き場を変えていればそれに従う */
export function huggingFaceHubDir(env: NodeJS.ProcessEnv, home: string): string {
  if (env.HF_HUB_CACHE?.trim()) return env.HF_HUB_CACHE.trim()
  if (env.HF_HOME?.trim()) return join(env.HF_HOME.trim(), 'hub')
  return join(home, '.cache', 'huggingface', 'hub')
}
const SAVED_GB: Record<Quantize, number> = { 4: 5.5, 6: 7.9 }
const EDIT_SAVED_GB = 8
/**
 * 任意の道具の大きさ（GB）。実測（この Mac）:
 *   iopaint の置き場 1.2GB ＋ LaMa の重み 0.2GB（torch を引くので大きい）
 *   rembg の置き場 0.55GB ＋ U²-Net 0.18GB
 */
const INPAINT_GB = 1.5
const BACKGROUND_GB = 0.8

export function requiredGBTable(): SetupStatus['requiredGB'] {
  return {
    generate: {
      4: DOWNLOAD_GB['z-image-turbo'] + SAVED_GB[4],
      6: DOWNLOAD_GB['z-image-turbo'] + SAVED_GB[6],
    },
    edit: DOWNLOAD_GB['flux2-klein-4b'] + EDIT_SAVED_GB,
    inpaint: INPAINT_GB,
    background: BACKGROUND_GB,
  }
}

/** 選んだ組み合わせで、足りないものにだけ要る空き（GB） */
export function requiredDiskGB(
  missing: { generate: boolean; edit: boolean; inpaint?: boolean; background?: boolean },
  options: SetupOptions,
): number {
  const table = requiredGBTable()
  return (
    (missing.generate ? table.generate[options.quantize] : 0) +
    (missing.edit && options.editModel ? table.edit : 0) +
    (missing.inpaint !== false && options.inpaint ? table.inpaint : 0) +
    (missing.background !== false && options.background ? table.background : 0)
  )
}

/**
 * 搭載メモリで量子化を選ぶ。6bit のピークは 9.12GB（README の実測表）で、
 * 16GB 機では OS と画面の分が残らない。18GB 以上なら 6bit（8bit と見分けがつかない）。
 */
export function recommendedQuantize(totalMemBytes: number): Quantize {
  return totalMemBytes >= 18 * 2 ** 30 ? 6 : 4
}

/**
 * uv を探す順。同梱したものを最優先にするのは、配布側で版を固定できる唯一の場所だから。
 * 次に uv 自身の既定の置き場、Homebrew、cargo。GUI から起動されると PATH が
 * /usr/bin:/bin 程度しか無いので、**PATH は当てにせず絶対パスで見る**。
 */
/** Homebrew の実行ファイル置き場（Apple Silicon と Intel）。探す先と子プロセスの PATH で共有する */
const BREW_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'] as const

export function uvCandidates(env: NodeJS.ProcessEnv, home: string): UvLocation[] {
  const bundled = env.PROVISION_UV?.trim()
  return [
    ...(bundled ? [{ path: bundled, source: 'bundled' as const }] : []),
    { path: join(home, '.local', 'bin', 'uv'), source: 'system' },
    ...BREW_BIN_DIRS.map((dir) => ({ path: join(dir, 'uv'), source: 'system' as const })),
    { path: join(home, '.cargo', 'bin', 'uv'), source: 'system' },
  ]
}

export function findUv(
  env: NodeJS.ProcessEnv,
  exists: (path: string) => boolean = existsSync,
  home: string = homedir(),
): UvLocation | null {
  return uvCandidates(env, home).find((candidate) => exists(candidate.path)) ?? null
}

export function findBrew(exists: (path: string) => boolean = existsSync): string | null {
  return BREW_BIN_DIRS.map((dir) => join(dir, 'brew')).find((path) => exists(path)) ?? null
}

/** 生成と保存の両方の実行ファイルが揃って初めて「入っている」 */
export function hasMflux(exists: (path: string) => boolean, home: string): boolean {
  return (
    exists(uvToolBinPath('mflux-generate-z-image-turbo', home)) &&
    exists(uvToolBinPath('mflux-save', home))
  )
}

/**
 * 子プロセスの出力を行に切る。**`\r` は「直前の行を書き換える」**——
 * 進捗バー（tqdm）は改行せずに `\r` で同じ行を更新し続けるので、
 * 素直に溜めると数百行の同じ行が並ぶ。端末と同じに見せる。
 */
export class LineSplitter {
  private rest = ''
  private overwriteNext = false

  constructor(private readonly emit: (line: string, overwrite: boolean) => void) {}

  push(chunk: string): void {
    let text = this.rest + chunk
    for (;;) {
      const at = text.search(/\r\n|\r|\n/)
      if (at < 0) break
      // 末尾の \r は次の塊で \r\n になるかもしれない。次を待つ
      if (text[at] === '\r' && at === text.length - 1) break
      const separator = text.startsWith('\r\n', at) ? '\r\n' : text[at]!
      this.flush(text.slice(0, at))
      this.overwriteNext = separator === '\r'
      text = text.slice(at + separator.length)
    }
    this.rest = text
  }

  /** 流れが閉じた。改行で終わっていない残りも 1 行として出す */
  end(): void {
    const tail = this.rest.replace(/\r$/, '')
    this.rest = ''
    this.flush(tail)
  }

  private flush(line: string): void {
    // 色の制御列は落とす。空行は捨てる——進捗バーが \r の後に空白だけを吐くことがある
    const clean = line.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    if (clean.trim() === '') return
    this.emit(clean, this.overwriteNext)
  }
}

export interface ProcessHandle {
  /** 終了コード。シグナルで止まったときや起動できなかったときは null */
  exited: Promise<number | null>
  kill: () => void
}

export type SpawnProcess = (
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string, overwrite: boolean) => void,
) => ProcessHandle

export interface RunnerDeps {
  env: NodeJS.ProcessEnv
  home: string
  exists: (path: string) => boolean
  spawnProcess: SpawnProcess
  mkdir: (path: string) => Promise<void>
  remove: (path: string) => Promise<void>
  rename: (from: string, to: string) => Promise<void>
  /** ファイルを 1 つ書く。LaMa の暖機に渡す小さな画像を置くのに使う */
  writeFile: (path: string, bytes: Uint8Array) => Promise<void>
  /** ディレクトリ配下のファイルの合計バイト数。取得の進み具合を測るのに使う */
  dirSizeBytes: (path: string) => Promise<number>
  /** 進み具合を測る間隔。テストでは短くする */
  progressIntervalMs?: number
  /** 導入が終わって生成できるようになったら呼ぶ。起動時に取った Agent の実測をやり直す */
  onReady?: () => void | Promise<void>
}

function spawnWithLines(
  bin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  onLine: (line: string, overwrite: boolean) => void,
): ProcessHandle {
  const child = spawn(bin, [...args], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = new LineSplitter(onLine)
  const err = new LineSplitter(onLine)
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => out.push(chunk))
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => err.push(chunk))
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      onLine(`起動できない: ${error.message}`, false)
      resolve(null)
    })
    child.once('close', (code) => {
      out.end()
      err.end()
      resolve(code)
    })
  })
  return {
    exited,
    kill: () => {
      child.kill('SIGTERM')
      // 10 秒待っても終わらなければ強制する。待つ側（サーバの終了）を止めない
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
      timer.unref()
      void exited.then(() => clearTimeout(timer))
    },
  }
}

/**
 * ディレクトリ配下のファイルの合計。**シンボリックリンクは辿らない**——
 * Hugging Face のキャッシュは snapshots/ から blobs/ へリンクを張るので、辿ると二重に数える。
 * 取得の途中で消えるファイルがあっても止まらない。
 */
async function dirSizeBytes(path: string): Promise<number> {
  let total = 0
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
      } else if (entry.isFile()) {
        try {
          total += (await stat(full)).size
        } catch {
          // 取得の途中で置き換わったファイル。次の計測で数える
        }
      }
    }
  }
  await walk(path)
  return total
}

export function defaultRunnerDeps(): RunnerDeps {
  return {
    env: process.env,
    home: homedir(),
    exists: existsSync,
    spawnProcess: spawnWithLines,
    mkdir: async (path) => {
      await mkdir(path, { recursive: true })
    },
    remove: (path) => rm(path, { recursive: true, force: true }),
    rename,
    writeFile: async (path, bytes) => {
      await writeFile(path, bytes)
    },
    dirSizeBytes,
  }
}

/**
 * 子プロセスへ渡す環境。GUI 起動の PATH は空同然なので、uv・Homebrew・mflux の
 * 置き場を明示して足す。`UV_TOOL_BIN_DIR` を固定するのは、XDG の設定で別の場所へ
 * 置かれると、こちらが探しに行く `~/.local/bin` と食い違うため。
 */
export function childEnv(
  base: NodeJS.ProcessEnv,
  home: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const localBin = join(home, '.local', 'bin')
  const path = [
    localBin,
    ...BREW_BIN_DIRS,
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    ...(base.PATH ? [base.PATH] : []),
  ].join(':')
  return {
    ...base,
    HOME: home,
    PATH: path,
    // Python の出力をパイプでも行ごとに流す。無いと終わるまで何も見えない
    PYTHONUNBUFFERED: '1',
    NO_COLOR: '1',
    UV_TOOL_BIN_DIR: localBin,
    ...extra,
  }
}

interface PlannedCommand {
  bin: string
  args: string[]
  /** ログに出す形。絶対パスやホームを畳んだもの */
  display: string
  env?: Record<string, string>
}

interface StepPlan {
  id: StepId
  label: string
  /** 走らせるコマンドを決める。もう済んでいれば skip の理由を返す */
  plan: () => Promise<PlannedCommand | { skip: string }>
  /** コマンドが 0 で終わったあとの仕上げ（置き場の名前を確定する、入ったことを確かめる） */
  after?: () => Promise<void>
  /** 失敗・中止のときに半端なものを消す */
  cleanup?: () => Promise<void>
  /** 走っている間の進み具合。段階の説明として画面に出す */
  progress?: () => Promise<string | undefined>
  doneDetail?: string
}

class CancelledError extends Error {
  constructor() {
    super('中止した')
    this.name = 'CancelledError'
  }
}

const MAX_LOG_LINES = 400

/** LaMa の重み。iopaint は torch hub のキャッシュへ置く */
export function lamaWeightPath(home: string): string {
  return join(home, '.cache', 'torch', 'hub', 'checkpoints', 'big-lama.pt')
}

/**
 * rembg の重み。**置き場が版で変わった**ので両方見る
 * （2.x は `~/.rembg/models/<名前>/<名前>.onnx`、古い版は `~/.u2net/<名前>.onnx`）。
 */
export function rembgWeightPath(
  home: string,
  exists: (path: string) => boolean,
): string | null {
  const candidates = [
    join(home, '.rembg', 'models', BACKGROUND_MODEL, `${BACKGROUND_MODEL}.onnx`),
    join(home, '.u2net', `${BACKGROUND_MODEL}.onnx`),
  ]
  return candidates.find((path) => exists(path)) ?? null
}

/**
 * LaMa の暖機に渡す 32x32 の画像とマスク（中央の 8x8 だけ白）。
 * 重みだけを落とす口が無いので、**一番小さい仕事をさせて取りに行かせる**。
 */
const WARMUP_IMAGE = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAKklEQVR4nO3NQQkAAAgEsItuFOMYyxQ+hMH+S/WcikAgEAgEAoFAIPgSLKGVoGpzJe5eAAAAAElFTkSuQmCC',
    'base64',
  ),
)
const WARMUP_MASK = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAI0lEQVR4nO3NMREAAAgEoO9fWhM4OnhCARKAI2ogEHwKAJY1xAm/QcdQMrgAAAAASUVORK5CYII=',
    'base64',
  ),
)

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class SetupRunner {
  private job: JobState | null = null
  private active: ProcessHandle | null = null
  private cancelled = false
  private lastLineFromProcess = false
  private running: Promise<void> = Promise.resolve()

  constructor(private readonly deps: RunnerDeps) {}

  /** 画面へ返す写し。ログは末尾だけ（数百行を 1.5 秒ごとに運ばない） */
  current(logTail = 60): JobState | null {
    if (!this.job) return null
    return {
      ...this.job,
      steps: this.job.steps.map((step) => ({ ...step })),
      log: this.job.log.slice(-logTail),
    }
  }

  /** テスト用。走っている導入が片付くまで待つ */
  settled(): Promise<void> {
    return this.running
  }

  start(options: SetupOptions, status: SetupStatus): JobState {
    if (this.job?.status === 'running') throw new Error('導入がもう進んでいる')
    if (!status.supported) throw new Error(status.unsupportedReason ?? 'この環境では導入できない')
    if (status.managedByEnv) {
      throw new Error('PROVISION_IMAGE_COMMAND で指定されているので、ここからは触らない')
    }
    const needed = requiredDiskGB(
      {
        generate: !status.generateModel.found,
        edit: !status.editModel.found,
        inpaint: !status.inpaint.found,
        background: !status.background.found,
      },
      options,
    )
    if (status.diskFreeGB !== undefined && status.diskFreeGB < needed) {
      throw new Error(
        `空き容量が足りない: 約 ${needed}GB 要るが、いまは ${status.diskFreeGB}GB。` +
          '元モデルは ~/.cache/huggingface に落ちるので、そこも含めて空ける',
      )
    }

    const plans = this.buildPlans(options)
    this.cancelled = false
    this.lastLineFromProcess = false
    this.active = null
    this.job = {
      status: 'running',
      options,
      steps: plans.map((plan) => ({ id: plan.id, label: plan.label, status: 'pending' })),
      log: [],
      startedAt: new Date().toISOString(),
    }
    this.running = this.run(this.job, plans)
    return this.current()!
  }

  cancel(): boolean {
    if (this.job?.status !== 'running') return false
    this.cancelled = true
    this.mark('■ 中止を頼まれた')
    this.active?.kill()
    return true
  }

  private buildPlans(options: SetupOptions): StepPlan[] {
    const { deps } = this
    const home = deps.home
    const uv: StepPlan = {
      id: 'uv',
      label: 'uv（Python ツールの導入係）',
      plan: async () => {
        const found = findUv(deps.env, deps.exists, home)
        if (found) return { skip: `${normalizeHome(found.path, home)} を使う` }
        const brew = findBrew(deps.exists)
        if (!brew) {
          throw new Error(
            'uv が見つからない。ターミナルで `brew install uv` を実行してから、もう一度',
          )
        }
        return {
          bin: brew,
          args: ['install', 'uv'],
          display: 'brew install uv',
          env: { HOMEBREW_NO_AUTO_UPDATE: '1' },
        }
      },
      after: async () => {
        if (!findUv(deps.env, deps.exists, home)) {
          throw new Error('brew は終わったが uv が見つからない')
        }
      },
    }
    const mflux: StepPlan = {
      id: 'mflux',
      label: `mflux ${PINNED.mflux}（mlx ${PINNED.mlx} / Python ${PINNED.python}）`,
      plan: async () => {
        if (hasMflux(deps.exists, home)) return { skip: '入っている' }
        const found = findUv(deps.env, deps.exists, home)
        if (!found) throw new Error('uv が無いので mflux を入れられない')
        const args = [
          'tool',
          'install',
          '--python',
          PINNED.python,
          `mflux==${PINNED.mflux}`,
          '--with',
          `mlx==${PINNED.mlx}`,
        ]
        return { bin: found.path, args, display: `uv ${args.join(' ')}` }
      },
      after: async () => {
        if (!hasMflux(deps.exists, home)) {
          throw new Error('uv は終わったが、~/.local/bin に mflux の実行ファイルが無い')
        }
      },
    }
    const modelStep = (
      id: StepId,
      label: string,
      model: keyof typeof DOWNLOAD_GB,
      quantize: number,
      name: string,
      alreadyHave: readonly string[],
    ): StepPlan => {
      const finalPath = join(home, '.cache', 'provision', name)
      const partial = `${finalPath}.partial`
      return {
        id,
        label,
        plan: async () => {
          const existing = findSavedModel(alreadyHave, deps.exists, home)
          if (existing) return { skip: `${normalizeHome(existing, home)} がある` }
          const save = uvToolBinPath('mflux-save', home)
          if (!deps.exists(save)) throw new Error('mflux-save が無い。先に mflux を入れる')
          // 前回の半端を消してから始める。mflux-save が上書きを拒むかに依らない
          await deps.remove(partial)
          await deps.mkdir(dirname(partial))
          const args = ['--model', model, '--quantize', String(quantize), '--path', partial]
          return {
            bin: save,
            args,
            display: `mflux-save --model ${model} --quantize ${quantize} --path ${normalizeHome(partial, home)}`,
          }
        },
        // 終わってから本来の名前へ。ここまで来て初めて「ある」と見なされる
        after: () => deps.rename(partial, finalPath),
        cleanup: () => deps.remove(partial),
        // 取得中は出力が止まって見える（Hugging Face はファイル単位でしか進みを出さない）。
        // キャッシュの大きさを測って、動いていることを見せる
        progress: async () => {
          const repoDir = join(
            huggingFaceHubDir(deps.env, home),
            `models--${HF_REPO[model].replace('/', '--')}`,
          )
          const bytes = await deps.dirSizeBytes(repoDir)
          return `取得 ${(bytes / 2 ** 30).toFixed(1)} / 約 ${DOWNLOAD_GB[model]}GB`
        },
        doneDetail: normalizeHome(finalPath, home),
      }
    }
    /** uv で Python の道具を 1 つ入れる段階。mflux と同じ形（版は固定する） */
    const uvToolStep = (
      id: StepId,
      label: string,
      command: string,
      spec: string,
      python: string,
    ): StepPlan => ({
      id,
      label,
      plan: async () => {
        if (deps.exists(uvToolBinPath(command, home))) return { skip: '入っている' }
        const found = findUv(deps.env, deps.exists, home)
        if (!found) throw new Error(`uv が無いので ${command} を入れられない`)
        const args = ['tool', 'install', '--python', python, spec]
        return { bin: found.path, args, display: `uv ${args.join(' ')}` }
      },
      after: async () => {
        if (!deps.exists(uvToolBinPath(command, home))) {
          throw new Error(`uv は終わったが ~/.local/bin/${command} が無い`)
        }
      },
    })

    const steps: StepPlan[] = [
      uv,
      mflux,
      // どの量子化でも既にあれば足さない。33GB の取得を黙って始めないため
      modelStep(
        'generate-model',
        `生成モデル z-image-turbo ${options.quantize}bit`,
        'z-image-turbo',
        options.quantize,
        `z-image-turbo-${options.quantize}bit`,
        [...MODEL_DIRS_BEST_FIRST],
      ),
    ]
    if (options.editModel) {
      steps.push(
        modelStep(
          'edit-model',
          '編集モデル flux2-klein-4b 8bit',
          'flux2-klein-4b',
          8,
          EDIT_MODEL_DIR,
          [EDIT_MODEL_DIR],
        ),
      )
    }
    if (options.inpaint) {
      steps.push(
        uvToolStep(
          'inpaint',
          `範囲の消去 IOPaint ${PINNED.iopaint}（LaMa）`,
          'iopaint',
          `iopaint==${PINNED.iopaint}`,
          PINNED.inpaintPython,
        ),
      )
      steps.push({
        id: 'inpaint-model',
        label: 'LaMa の重み（約 0.2GB）',
        /**
         * **重みだけを落とす口が無い**（`iopaint download` は HuggingFace の SD 用）。
         * 小さな画像を 1 枚だけ消させて取りに行かせる。**実行するコマンドは
         * 本番と同じもの**（`suggestInpaintCommand`）なので、ここで通れば本番も通る
         */
        plan: async () => {
          if (deps.exists(lamaWeightPath(home))) return { skip: '入っている' }
          const template = suggestInpaintCommand(deps.exists, home)
          if (!template) throw new Error('iopaint が無い。先に入れる')
          const dir = join(home, '.cache', 'provision', '.warmup')
          await deps.remove(dir)
          await deps.mkdir(join(dir, 'out'))
          const image = join(dir, 'image.png')
          const mask = join(dir, 'mask.png')
          await deps.writeFile(image, WARMUP_IMAGE)
          await deps.writeFile(mask, WARMUP_MASK)
          const args = template
            .trim()
            .split(/\s+/)
            .map((arg) =>
              arg
                .replaceAll('{image}', image)
                .replaceAll('{mask}', mask)
                .replaceAll('{outputDir}', join(dir, 'out'))
                .replaceAll('{out}', join(dir, 'out', 'image.png')),
            )
          const bin = args.shift()!
          return { bin, args, display: `${bin.split('/').pop()} run --model lama（暖機）` }
        },
        after: async () => {
          await deps.remove(join(home, '.cache', 'provision', '.warmup'))
          if (!deps.exists(lamaWeightPath(home))) {
            throw new Error('暖機は終わったが LaMa の重みが見つからない')
          }
        },
        cleanup: () => deps.remove(join(home, '.cache', 'provision', '.warmup')),
      })
    }
    if (options.background) {
      steps.push(
        uvToolStep(
          'background',
          `背景の透明化 rembg ${PINNED.rembg}（U²-Net）`,
          'rembg',
          `rembg[cpu,cli]==${PINNED.rembg}`,
          PINNED.backgroundPython,
        ),
      )
      steps.push({
        id: 'background-model',
        label: `${BACKGROUND_MODEL} の重み（約 0.18GB）`,
        /**
         * **モデルを名指しして落とす。** 名指ししないと rembg は版ごとの既定を
         * 取りに行く（2.0.83 では 1.02GB の bria-rmbg）。実行時も名指しするので、
         * ここで落としたものがそのまま使われる
         */
        plan: async () => {
          if (rembgWeightPath(home, deps.exists) !== null) return { skip: '入っている' }
          const bin = uvToolBinPath('rembg', home)
          if (!deps.exists(bin)) throw new Error('rembg が無い。先に入れる')
          return {
            bin,
            args: ['d', BACKGROUND_MODEL],
            display: `rembg d ${BACKGROUND_MODEL}`,
          }
        },
        after: async () => {
          if (rembgWeightPath(home, deps.exists) === null) {
            throw new Error(`取得は終わったが ${BACKGROUND_MODEL} の重みが見つからない`)
          }
        },
      })
    }
    return steps
  }

  private async run(job: JobState, plans: StepPlan[]): Promise<void> {
    try {
      for (const plan of plans) {
        if (this.cancelled) throw new CancelledError()
        const state = job.steps.find((step) => step.id === plan.id)!
        state.status = 'running'
        const command = await plan.plan().catch((error: unknown) => {
          state.status = 'failed'
          state.detail = messageOf(error)
          throw error
        })
        if ('skip' in command) {
          state.status = 'skipped'
          state.detail = command.skip
          continue
        }
        // plan() の間に中止されていたら走らせない。この窓で kill する相手はまだ居ない
        if (this.cancelled) {
          await plan.cleanup?.()
          state.status = 'failed'
          state.detail = '中止した'
          throw new CancelledError()
        }
        this.mark(`▶ ${command.display}`)
        const handle = this.deps.spawnProcess(
          command.bin,
          command.args,
          childEnv(this.deps.env, this.deps.home, command.env),
          (line, overwrite) => this.append(line, overwrite),
        )
        this.active = handle
        const stopTracking = plan.progress ? this.trackProgress(plan.progress, state) : undefined
        const code = await handle.exited
        stopTracking?.()
        this.active = null
        if (this.cancelled) {
          await plan.cleanup?.()
          state.status = 'failed'
          state.detail = '中止した'
          throw new CancelledError()
        }
        if (code !== 0) {
          await plan.cleanup?.()
          state.status = 'failed'
          state.detail = code === null ? '起動できないか、途中で止められた' : `終了コード ${code}`
          throw new Error(`${plan.label} が終わらなかった（${state.detail}）`)
        }
        try {
          await plan.after?.()
        } catch (error) {
          await plan.cleanup?.()
          state.status = 'failed'
          state.detail = messageOf(error)
          throw error
        }
        state.status = 'done'
        if (plan.doneDetail) state.detail = plan.doneDetail
      }
      job.status = 'done'
      this.mark('✓ 揃った。生成できる')
    } catch (error) {
      job.status = error instanceof CancelledError || this.cancelled ? 'cancelled' : 'failed'
      job.error = messageOf(error)
      this.mark(`✗ ${job.error}`)
    } finally {
      job.endedAt = new Date().toISOString()
      this.active = null
    }
    if (job.status === 'done') {
      try {
        await this.deps.onReady?.()
      } catch {
        // 実測のやり直しに失敗しても導入は済んでいる。次の起動で取り直される
      }
    }
  }

  /** 走っている間、進み具合を段階の説明に書き続ける。止める関数を返す */
  private trackProgress(
    progress: () => Promise<string | undefined>,
    state: StepState,
  ): () => void {
    let stopped = false
    let measuring = false
    const tick = async () => {
      if (stopped || measuring) return
      measuring = true
      try {
        const detail = await progress()
        if (!stopped && detail) state.detail = detail
      } catch {
        // 測れなくても導入は続く
      } finally {
        measuring = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), this.deps.progressIntervalMs ?? 5000)
    timer.unref()
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }

  /** 進行の目印。子プロセスの出力とは別物なので、\r で上書きされない */
  private mark(line: string): void {
    if (!this.job) return
    this.job.log.push(line)
    this.lastLineFromProcess = false
    this.trim()
  }

  private append(line: string, overwrite: boolean): void {
    if (!this.job) return
    const { log } = this.job
    if (overwrite && this.lastLineFromProcess && log.length > 0) {
      log[log.length - 1] = line
    } else {
      log.push(line)
    }
    this.lastLineFromProcess = true
    this.trim()
  }

  private trim(): void {
    if (this.job && this.job.log.length > MAX_LOG_LINES) {
      this.job.log.splice(0, this.job.log.length - MAX_LOG_LINES)
    }
  }
}

/** いま何が揃っていて何が足りないかを実測する。画面はこれをそのまま出す */
export async function probeSetupStatus(
  runner: SetupRunner,
  deps: Pick<RunnerDeps, 'env' | 'exists' | 'home'> = defaultRunnerDeps(),
  platform: { platform: string; arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): Promise<SetupStatus> {
  const supported = platform.platform === 'darwin' && platform.arch === 'arm64'
  const managedByEnv = Boolean(deps.env.PROVISION_IMAGE_COMMAND?.trim())

  let ready = false
  let commandTemplate: string | undefined
  try {
    commandTemplate = normalizeHome(resolveImageCommand(deps.env), deps.home)
    ready = true
  } catch {
    ready = false
  }

  const uv = findUv(deps.env, deps.exists, deps.home)
  const mfluxFound = hasMflux(deps.exists, deps.home)
  const generate = findSavedModel(MODEL_DIRS_BEST_FIRST, deps.exists, deps.home)
  const edit = findSavedModel([EDIT_MODEL_DIR], deps.exists, deps.home)
  /** 任意の道具は、**実行ファイルと重みの両方**が揃って初めて「入っている」 */
  const inpaintFound =
    deps.exists(uvToolBinPath('iopaint', deps.home)) && deps.exists(lamaWeightPath(deps.home))
  const backgroundFound =
    deps.exists(uvToolBinPath('rembg', deps.home)) &&
    rembgWeightPath(deps.home, deps.exists) !== null

  // 版と空き容量は互いに関係ないので同時に測る。版の組み立ては Agent と同じ関数に任せ、
  // 画面に出る文字列と来歴に載る文字列がずれないようにする
  const [versions, inpaintVersions, backgroundVersions, diskFreeGB] = await Promise.all([
    mfluxFound
      ? probeToolEnvironment(
          () => uvToolBinPath('mflux-generate-z-image-turbo', deps.home),
          ['mflux', 'mlx'],
          undefined,
        ).then((tool) => tool.version)
      : Promise.resolve(undefined),
    inpaintFound
      ? probeToolEnvironment(
          () => uvToolBinPath('iopaint', deps.home),
          ['iopaint', 'torch'],
          undefined,
        ).then((tool) => tool.version)
      : Promise.resolve(undefined),
    backgroundFound
      ? probeToolEnvironment(
          () => uvToolBinPath('rembg', deps.home),
          ['rembg', 'onnxruntime'],
          undefined,
        ).then((tool) => tool.version)
      : Promise.resolve(undefined),
    statfs(deps.home)
      .then((stats) => Math.round((Number(stats.bavail) * Number(stats.bsize)) / 2 ** 30))
      .catch(() => undefined),
  ])
  const memory = totalmem()

  return {
    supported,
    ...(supported
      ? {}
      : {
          unsupportedReason:
            'ここからの導入は Apple Silicon の Mac だけ（mflux が MLX でしか動かない）。' +
            '他の環境では PROVISION_IMAGE_COMMAND で独自の生成コマンドを指す',
        }),
    managedByEnv,
    ready,
    ...(commandTemplate ? { commandTemplate } : {}),
    uv: {
      found: uv !== null,
      ...(uv ? { path: normalizeHome(uv.path, deps.home), source: uv.source } : {}),
      brew: findBrew(deps.exists) !== null,
    },
    mflux: { found: mfluxFound, ...(versions ? { versions } : {}) },
    generateModel: {
      found: generate !== null,
      ...(generate ? { path: normalizeHome(generate, deps.home) } : {}),
    },
    editModel: {
      found: edit !== null,
      ...(edit ? { path: normalizeHome(edit, deps.home) } : {}),
    },
    inpaint: {
      found: inpaintFound,
      ...(inpaintVersions ? { versions: inpaintVersions } : {}),
    },
    background: {
      found: backgroundFound,
      ...(backgroundVersions ? { versions: backgroundVersions } : {}),
    },
    memoryGB: Math.round(memory / 2 ** 30),
    recommendedQuantize: recommendedQuantize(memory),
    ...(diskFreeGB !== undefined ? { diskFreeGB } : {}),
    requiredGB: requiredGBTable(),
    pinned: PINNED,
    job: runner.current(),
  }
}

/**
 * サーバが止められたら子プロセスも止める。ハンドラを付けると「シグナルで終了する」
 * 既定が消えるので、自分で exit する。孤児になった mflux-save が次の導入と
 * 同じ置き場へ書き続けるのを防ぐ。
 */
export function stopOnShutdown(runner: SetupRunner, proc: NodeJS.Process = process): void {
  const signals: Array<[NodeJS.Signals, number]> = [
    ['SIGTERM', 15],
    ['SIGINT', 2],
    ['SIGHUP', 1],
  ]
  for (const [signal, number] of signals) {
    proc.once(signal, () => {
      runner.cancel()
      proc.exit(128 + number)
    })
  }
}
