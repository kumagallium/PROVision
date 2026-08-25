/**
 * 2 つの版を突き合わせて「何が違うか」を出す（D-015）。
 *
 * **答えられるのは「記録した項目のどれが違うか」までである。**
 * 「環境が同一だった」とは言えない——記録していない変数（Metal のカーネル実装、
 * 実行時のメモリ圧、同時に走っていた別プロセス）が残るからで、この非対称は意図したもの。
 * 「その差が絵を変えた原因だ」とも言えない。相関どまりで、因果は言えない。
 *
 * だからこの関数が返すのは**原因の証明ではなく、容疑者の絞り込み**である。
 * ここを曖昧にすると、この機能自身が D-015 で戒めた過大主張になる。
 */
import type { ProvGraph } from './graph.js'
import type { GenerationActivity, Iri, ProvAgent } from './types.js'

export interface FieldDifference {
  /** 画面に出す項目名 */
  label: string
  /** 左（比較元）の値。記録が無ければ undefined */
  left?: string
  /** 右（比較先）の値。記録が無ければ undefined */
  right?: string
  /**
   * 片側にしか記録が無いか。
   * **「値が違う」と「片方は調べていない」は別物**なので、区別して返す（D-015）。
   */
  oneSided: boolean
}

export interface ComparisonResult {
  /** 突き合わせた項目の数。差分が 0 件でも「何件見たうえで 0 件か」が分かるように */
  compared: number
  differences: FieldDifference[]
  /** 突き合わせられなかった理由。両側が揃わなかったときだけ入る */
  unavailable?: string
}

/** 指定の層。順は画面の並び順であり、上ほど絵への効きが大きい */
const ACTIVITY_FIELDS: ReadonlyArray<{
  label: string
  of: (a: GenerationActivity) => string | undefined
}> = [
  { label: 'prompt', of: (a) => a.prompt },
  { label: 'negative prompt', of: (a) => a.negativePrompt },
  { label: 'model', of: (a) => a.model },
  { label: 'seed', of: (a) => String(a.seed) },
  { label: 'steps', of: (a) => (a.steps === undefined ? undefined : String(a.steps)) },
  { label: 'guidance', of: (a) => (a.guidance === undefined ? undefined : String(a.guidance)) },
  {
    label: 'size',
    of: (a) => (a.width === undefined ? undefined : `${a.width}x${a.height ?? a.width}`),
  },
  {
    label: 'image strength',
    of: (a) => (a.imageStrength === undefined ? undefined : String(a.imageStrength)),
  },
  { label: 'conditioning image', of: (a) => a.conditioningImageDigest },
  { label: 'mask image', of: (a) => a.maskImageDigest },
  { label: 'tool', of: (a) => a.selectedTool },
  { label: 'tool arguments', of: (a) => a.toolArguments },
  { label: 'command', of: (a) => a.commandTemplate },
  { label: 'planning', of: (a) => a.planningMode },
  { label: 'planner model', of: (a) => a.plannerModel },
  { label: 'reproducibility', of: (a) => a.reproducibility },
]

/** 環境の層。Agent 1 件につきこの 3 項目を見る */
const AGENT_FIELDS: ReadonlyArray<{ label: string; of: (a: ProvAgent) => string | undefined }> = [
  { label: 'version', of: (a) => a.version },
  { label: 'model fingerprint', of: (a) => a.modelFingerprint },
  { label: 'platform', of: (a) => a.platform },
]

function differenceOf(
  label: string,
  left: string | undefined,
  right: string | undefined,
): FieldDifference | undefined {
  if (left === right) return undefined
  // 両側とも記録が無いなら、そもそも比べていない。差分として出さない
  if (left === undefined && right === undefined) return undefined
  return { label, left, right, oneSided: left === undefined || right === undefined }
}

/**
 * その Activity に関わった SoftwareAgent を `role` で引けるようにする。
 *
 * IRI は環境ごとに変わる（D-015）ので、IRI で対応付けると
 * **環境が違うだけで「別のツール」に見えてしまい、肝心の差分が出ない**。
 */
function softwareAgentsByRole(graph: ProvGraph, activity: GenerationActivity): Map<string, ProvAgent> {
  const all = new Map(graph.listAgents().map((a) => [a.id, a]))
  const found = new Map<string, ProvAgent>()
  for (const id of activity.wasAssociatedWith) {
    const agent = all.get(id)
    if (!agent || agent.kind !== 'SoftwareAgent') continue
    // role が無いのは、この仕組みより前に記録された版。IRI で代用する
    found.set(agent.role ?? agent.id, agent)
  }
  return found
}

/**
 * 2 つの版を突き合わせる。差分のあった項目だけを返す。
 *
 * 左右の順は呼び側が決める。画面では「いま見ている版」を右に置く。
 */
export function compareGenerations(
  graph: ProvGraph,
  leftEntity: Iri,
  rightEntity: Iri,
): ComparisonResult {
  const left = graph.activityThatGenerated(leftEntity)
  const right = graph.activityThatGenerated(rightEntity)
  if (!left || !right) {
    return {
      compared: 0,
      differences: [],
      unavailable: '片方の版に、生成の記録が残っていない',
    }
  }

  const differences: FieldDifference[] = []
  let compared = 0

  for (const field of ACTIVITY_FIELDS) {
    compared += 1
    const diff = differenceOf(field.label, field.of(left), field.of(right))
    if (diff) differences.push(diff)
  }

  const leftAgents = softwareAgentsByRole(graph, left)
  const rightAgents = softwareAgentsByRole(graph, right)
  const roles = [...new Set([...leftAgents.keys(), ...rightAgents.keys()])].sort()
  for (const role of roles) {
    const l = leftAgents.get(role)
    const r = rightAgents.get(role)
    for (const field of AGENT_FIELDS) {
      compared += 1
      const diff = differenceOf(`${role} ${field.label}`, l && field.of(l), r && field.of(r))
      if (diff) differences.push(diff)
    }
  }

  return { compared, differences }
}

/**
 * その版と食い違った相手を探す。`alternateOf` は新しい版から古い版へ 1 方向にしか
 * 張られないので、**両向きに引く**。どちらを選んでいても相手が見つかるようにする。
 */
export function alternatesOf(graph: ProvGraph, entityId: Iri): Iri[] {
  const self = graph.getEntity(entityId)
  const found = new Set<Iri>()
  if (self?.alternateOf && graph.getEntity(self.alternateOf)) found.add(self.alternateOf)
  for (const other of graph.listEntities()) {
    if (other.alternateOf === entityId) found.add(other.id)
  }
  return [...found].sort()
}
