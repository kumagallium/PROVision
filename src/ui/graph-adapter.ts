/**
 * ProvGraph を React Flow のノード・辺に写す。
 *
 * 純関数にしておく。ここが画面から独立していれば、
 * 「どの世代がどう繋がっているか」をテストで確かめられる。
 */
import type { ProvGraph } from '../prov/graph.js'
import type { GenerationActivity, ImageEntity, Iri } from '../prov/types.js'

export type FlowNodeKind = 'image' | 'activity' | 'external'

export interface FlowNodeData {
  kind: FlowNodeKind
  label: string
  /** 画像ノードのみ。data/ 配下の相対 URL */
  imageUrl?: string
  entity?: ImageEntity
  activity?: GenerationActivity
  /** 外部リソースノードのみ */
  iri?: Iri
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
  data: { kind: 'used' | 'referenced' | 'generated' }
}

/**
 * Entity の location（data/run/images/xxx.png）を、
 * vite が配信する URL（/run/images/xxx.png）に直す。
 */
export function imageUrlOf(entity: ImageEntity): string | undefined {
  if (!entity.location) return undefined
  const normalized = entity.location.replace(/^\.?\//, '')
  return `/${normalized.replace(/^data\//, '')}`
}

export function toFlow(graph: ProvGraph): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = []
  const edges: FlowEdge[] = []
  const at = { x: 0, y: 0 }

  for (const entity of graph.listEntities()) {
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

  const externals = new Set<Iri>()
  for (const activity of graph.listActivities()) {
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
