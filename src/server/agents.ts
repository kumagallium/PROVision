/**
 * 実行環境つきの SoftwareAgent と、実行したコマンドの雛形を組み立てる（D-015 / D-017）。
 *
 * `index.ts` から切り出してあるのは**テストできる形にするため**。あちらは
 * import した時点でサーバが起動するので、中の関数を単体で確かめられない。
 * ここに置いた判断（slug の作り方、生成と編集の選び分け）は、間違えても
 * 静かに壊れる——過去の Activity が今の版で作られたことになる、
 * 編集なのに生成用コマンドが記録される——ので、テストの届く所に出す。
 */
import type { ProvGraph } from '../prov/graph.js'
import type { ProvAgent } from '../prov/types.js'
import { sha256 } from '../prov/sha256.js'
import { imageToolExecutor, type ImageToolName } from '../ai/tools.js'
import {
  binaryOf,
  formatVersions,
  modelPathOf,
  normalizeHome,
  probeCommandVersion,
  probeInstalledVersions,
  probeModelFingerprint,
  probePythonVersion,
} from '../image/environment.js'

export interface ToolEnvironment {
  version?: string
  modelFingerprint?: string
  platform?: string
}

/**
 * Agent の slug。**環境を畳み込む**のが肝。
 *
 * 同じ slug のまま版だけ差し替えると、`addAgent` は既存を上書きしないので
 * **過去の Activity まで今の版で作られたことになる**。環境が変われば別の Agent が
 * 生まれ、各 Activity は実際に走った環境を指したまま残る。
 *
 * 何も実測できなかったときは素の slug に落とす——既存のグラフと繋がる形を保つため。
 */
export function agentSlug(role: string, env: ToolEnvironment): string {
  const key = [env.version ?? '', env.modelFingerprint ?? '', env.platform ?? ''].join('|')
  const known = key.replace(/\|/g, '').trim().length > 0
  return known ? `${role}-${sha256(key).slice(0, 12)}` : role
}

/**
 * 画面に出す名前。版はツール名込みの文字列（`mflux 0.18.1, mlx 0.31.2`）なので、
 * 区切って並べる。素朴に連結するとツール名が二重になる。
 */
export function agentLabel(label: string, env: ToolEnvironment): string {
  return env.version ? `${label} — ${env.version}` : label
}

/** 実行環境つきの SoftwareAgent をグラフへ置く */
export function addSoftwareAgent(
  graph: ProvGraph,
  role: string,
  label: string,
  env: ToolEnvironment = {},
): ProvAgent {
  return graph.addAgent(agentSlug(role, env), agentLabel(label, env), 'SoftwareAgent', {
    // slug は環境ごとに変わる。環境をまたいで「同じツール」だと言えるのは role だけ
    role,
    ...env,
  })
}

/**
 * 実行したコマンドの雛形。**ホームを `~` に畳んでから返す。**
 *
 * 生成と編集は別コマンド＝別モデルなので、入力画像の有無で選び分ける。
 * Jimp はアプリに同梱で外部コマンドを呼ばないため、記録するものが無い。
 */
export function commandTemplateOf(
  tool: ImageToolName,
  hasConditioningImage: boolean,
  resolvers: {
    generate: () => string
    edit: () => string
    inpaint: () => string
    background: () => string
  },
): string | undefined {
  try {
    switch (imageToolExecutor(tool)) {
      case 'image-model':
        return normalizeHome(hasConditioningImage ? resolvers.edit() : resolvers.generate())
      case 'inpaint':
        return normalizeHome(resolvers.inpaint())
      case 'background':
        return normalizeHome(resolvers.background())
      default:
        return undefined
    }
  } catch {
    // 設定不足でテンプレートが解決できないだけ。生成時に別途エラーになる
    return undefined
  }
}

/**
 * ツールの実行環境を実測する。テンプレートが解決できなければ platform だけ返す。
 *
 * 版は **`--version` より先に置き場（dist-info）を見る**。mflux も iopaint も
 * rembg も `--version` を持っていない（実測）ので、問い合わせても何も返らない。
 * `PROVISION_IMAGE_COMMAND` で独自コマンドを差した場合だけ `--version` が効く。
 */
export async function probeToolEnvironment(
  resolve: () => string,
  packages: readonly string[],
  platform: string | undefined,
): Promise<ToolEnvironment> {
  try {
    const template = resolve()
    const bin = binaryOf(template)
    const modelPath = modelPathOf(template)
    // Python の版も容疑者に入れる。依存の解決が変わりうる
    const python = await probePythonVersion(bin)
    const names = python ? [...packages, 'python'] : packages
    const found = await probeInstalledVersions(bin, packages)
    const installed = formatVersions(python ? { ...found, python } : found, names)
    return {
      version: installed ?? (await probeCommandVersion(bin)),
      modelFingerprint: modelPath ? await probeModelFingerprint(modelPath) : undefined,
      platform,
    }
  } catch {
    return { platform }
  }
}
