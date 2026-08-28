/**
 * ProvGraph を React Flow のノード・辺に写す。
 *
 * 純関数にしておく。ここが画面から独立していれば、
 * 「どの世代がどう繋がっているか」をテストで確かめられる。
 */
import type { ProvGraph } from '../prov/graph.js'
import type { GenerationActivity, ImageEntity, Iri } from '../prov/types.js'

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
  /** 別の会話から材料として借りてきた版か（D-021） */
  borrowed?: boolean
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
  data: { kind: 'used' | 'referenced' | 'generated' | 'alternate' | 'planned' }
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
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const at = { x: 0, y: 0 }

  const entities = root === undefined ? graph.listEntities() : graph.session(root)
  const inScope = new Set(entities.map((e) => e.id))
  const activities = graph
    .listActivities()
    .filter((a) => inScope.has(a.generated))

  for (const entity of entities) {
    nodes.push({
      id: entity.id,
      type: 'image',
      position: { ...at },
      data: {
        kind: 'image',
        label: entity.label,
        entity,
        ...(imageUrlOf(entity) ? { imageUrl: imageUrlOf(entity) } : {}),
      },
    })
  }

  // 出し直して食い違った版は、元の版と線で結ぶ。派生ではないので見た目を変える
  for (const entity of entities) {
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
      },
    })

    for (const used of activity.used) {
      edges.push({
        id: `${used}->${activity.id}`,
        source: used,
        target: activity.id,
        data: { kind: 'used' },
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
