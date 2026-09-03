/**
 * ProvGraph を React Flow のノード・辺に写す。
 *
 * 純関数にしておく。ここが画面から独立していれば、
 * 「どの世代がどう繋がっているか」をテストで確かめられる。
 */
import type { ProvGraph } from '../prov/graph.js'
import type { GenerationActivity, ImageEntity, Iri } from '../prov/types.js'
import { imageToolDefinition, type ImageToolName } from '../ai/tools.js'

export type FlowNodeKind = 'image' | 'activity' | 'external' | 'plan'

export interface FlowNodeData {
  kind: FlowNodeKind
  label: string
  /** 画像ノードのみ。data/ 配下の相対 URL */
  imageUrl?: string
  entity?: ImageEntity
  activity?: GenerationActivity
  /** 外部リソースノードのみ */
  iri?: Iri
  /** 指示ノードのみ。その送信から走った本数 */
  branches?: number
  /**
   * 生成ノードのみ。画像モデルへ実際に渡った全文（清書、D-030）。
   * 意図と同じ文しか無いとき、清書を使わないツールのときは付けない
   */
  prompt?: string
  /** 生成ノードのみ。指示の節点（D-022）から生えている＝意図はそちらが出す */
  planned?: boolean
  /** 別の会話から材料として借りてきた版か（D-021） */
  borrowed?: boolean
  /** 利用者がアーカイブした版か（D-032） */
  archived?: boolean
  /**
   * 直近の送信で生まれた版か（D-028）。**写しの段階では決めない**——
   * これは記録の性質ではなく画面の状態なので、`toFlow` ではなく描く直前に載せる
   */
  fresh?: boolean
  [key: string]: unknown
}

export interface FlowNode {
  id: string
  type: FlowNodeKind
  data: FlowNodeData
  position: { x: number; y: number }
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  /** 生成の辺か、人間が参照した辺か。見た目を変える */
  data: { kind: 'used' | 'referenced' | 'generated' | 'alternate' | 'planned' | 'skipped' }
}

/** その道具が清書（画像モデルへ渡す全文）を使うか。知らない名前なら判断しない */
function usesPrompt(tool: string | undefined): boolean | undefined {
  if (!tool) return undefined
  try {
    return imageToolDefinition(tool as ImageToolName).usesPrompt === true
  } catch {
    return undefined
  }
}

/**
 * 節点に出す清書（D-030）。**実行された全文**であって、意図の言い換えではない。
 *
 * 道具が分かるならそれで決める（Jimp や取り込みは清書を持たない）。分からない
 * 古い記録では、意図や版の名前と同じ文なら出しても言えることが増えないので付けない。
 */
export function executedPromptOf(activity: GenerationActivity): string | undefined {
  const prompt = activity.prompt.trim()
  if (!prompt) return undefined
  const uses = usesPrompt(activity.selectedTool)
  if (uses === false) return undefined
  if (uses === undefined && (prompt === activity.intent?.trim() || prompt === activity.label)) {
    return undefined
  }
  return prompt
}

/**
 * Entity の location を、サーバが配る URL に直す。
 *
 * location は記録した時期によって `images/x.png` だったり
 * `data/run/images/x.png` だったりする。ファイル名だけ見れば足りる。
 */
export function imageUrlOf(entity: ImageEntity): string | undefined {
  if (!entity.location) return undefined
  const name = entity.location.split('/').pop()
  return name ? `/api/images/${name}` : undefined
}

/**
 * グラフを React Flow のノード・辺にする。
 *
 * `root` を渡すと、その会話（根ごとの連結成分）だけを写す。
 * 真ん中の面には「いま話している会話」だけを出すため。
 */
export function toFlow(
  graph: ProvGraph,
  root?: string,
  options: { hideArchived?: boolean } = {},
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const at = { x: 0, y: 0 }

  const entities = root === undefined ? graph.listEntities() : graph.session(root)
  const inScope = new Set(entities.map((e) => e.id))
  /**
   * アーカイブした版はグラフからも外す（D-032）。**既定では外さない**——
   * 写し取りは記録どおりに写し、隠すかどうかは見る側が決める
   */
  const hidden = new Set<Iri>(
    options.hideArchived ? entities.filter((e) => graph.isArchived(e.id)).map((e) => e.id) : [],
  )
  const activities = graph
    .listActivities()
    .filter((a) => inScope.has(a.generated) && !hidden.has(a.generated))

  /**
   * 隠した版の上にある、**見えている一番近い版**。繋ぎ直す先を探す。
   * 見つからない（根まで全部隠れている）なら、その子は根として描かれる
   */
  const visibleAncestor = (id: Iri): Iri | undefined => {
    const seen = new Set<Iri>()
    let current: Iri | undefined = id
    while (current !== undefined && hidden.has(current) && !seen.has(current)) {
      seen.add(current)
      const act = graph.activityThatGenerated(current)
      current = act?.branchedFrom ?? act?.used[0]
    }
    return current !== undefined && inScope.has(current) && !hidden.has(current)
      ? current
      : undefined
  }

  for (const entity of entities) {
    if (hidden.has(entity.id)) continue
    nodes.push({
      id: entity.id,
      type: 'image',
      position: { ...at },
      data: {
        kind: 'image',
        label: entity.label,
        entity,
        ...(graph.isArchived(entity.id) ? { archived: true } : {}),
        ...(imageUrlOf(entity) ? { imageUrl: imageUrlOf(entity) } : {}),
      },
    })
  }

  // 出し直して食い違った版は、元の版と線で結ぶ。派生ではないので見た目を変える
  for (const entity of entities) {
    if (hidden.has(entity.id) || hidden.has(entity.alternateOf ?? '')) continue
    if (entity.alternateOf && inScope.has(entity.alternateOf)) {
      edges.push({
        id: `${entity.alternateOf}~${entity.id}`,
        source: entity.alternateOf,
        target: entity.id,
        data: { kind: 'alternate' },
      })
    }
  }

  /**
   * 1 回の送信（D-022）。**候補が枝分かれする起点**なので、指示を節点として置く。
   * 親が無い候補は兄弟になりようがないが、同じ指示からは生まれている
   */
  const plans = new Set<Iri>()
  for (const activity of activities) {
    if (activity.planId) plans.add(activity.planId)
  }
  for (const planId of plans) {
    const plan = graph.getPlan(planId)
    if (!plan) continue
    nodes.push({
      id: plan.id,
      type: 'plan',
      position: { ...at },
      data: {
        kind: 'plan',
        label: plan.label,
        branches: activities.filter((a) => a.planId === plan.id).length,
      },
    })
  }

  /**
   * **会話の外から材料として借りた版**（D-021）。会話は分岐元でたどるので、
   * 借りた側はこの会話に属さない。だがノードを置かないと辺の端点が欠け、
   * ELK が例外を投げて**グラフが 1 本も描かれない**（実測）
   */
  for (const activity of activities) {
    for (const used of activity.used) {
      if (inScope.has(used)) continue
      const entity = graph.getEntity(used)
      if (!entity) continue
      inScope.add(used)
      nodes.push({
        id: entity.id,
        type: 'image',
        position: { ...at },
        data: {
          kind: 'image',
          label: entity.label,
          entity,
          borrowed: true,
          ...(imageUrlOf(entity) ? { imageUrl: imageUrlOf(entity) } : {}),
        },
      })
    }
  }

  const externals = new Set<Iri>()
  for (const activity of activities) {
    nodes.push({
      id: activity.id,
      type: 'activity',
      position: { ...at },
      data: {
        kind: 'activity',
        // 意図がある世代は意図を見出しにする。無い（＝初回）ときは版の名前
        label: activity.intent ?? activity.label,
        activity,
        // 節点が見せるのは実行された全文（D-030）。意図は指示の節点が出す
        ...(executedPromptOf(activity) ? { prompt: executedPromptOf(activity) } : {}),
        planned: activity.planId !== undefined,
      },
    })

    const relinked = new Set<Iri>()
    for (const used of activity.used) {
      if (!hidden.has(used)) {
        edges.push({
          id: `${used}->${activity.id}`,
          source: used,
          target: activity.id,
          data: { kind: 'used' },
        })
        continue
      }
      /**
       * 親を隠したときは、**その上の見えている版へ繋ぎ直す**（D-032）。
       * 辺ごと落とすと、子の版が「どこから来たか」を辿れなくなる。
       * 直接の派生ではないので、見た目は別にする
       */
      const ancestor = visibleAncestor(used)
      if (ancestor === undefined || relinked.has(ancestor)) continue
      relinked.add(ancestor)
      edges.push({
        id: `${ancestor}=>${activity.id}`,
        source: ancestor,
        target: activity.id,
        data: { kind: 'skipped' },
      })
    }
    for (const ref of activity.referenced) {
      externals.add(ref)
      edges.push({
        id: `${ref}->${activity.id}`,
        source: ref,
        target: activity.id,
        data: { kind: 'referenced' },
      })
    }
    if (activity.planId && plans.has(activity.planId)) {
      edges.push({
        id: `${activity.planId}~>${activity.id}`,
        source: activity.planId,
        target: activity.id,
        data: { kind: 'planned' },
      })
    }
    edges.push({
      id: `${activity.id}->${activity.generated}`,
      source: activity.id,
      target: activity.generated,
      data: { kind: 'generated' },
    })
  }

  for (const iri of externals) {
    nodes.push({
      id: iri,
      type: 'external',
      position: { ...at },
      data: { kind: 'external', label: iri.split('/').slice(-2).join('/'), iri },
    })
  }

  return { nodes, edges }
}
