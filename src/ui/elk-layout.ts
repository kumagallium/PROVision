/**
 * ELK layered レイアウト。「実測サイズ付きノード → 座標 Map」を返す純関数。
 *
 * prov-jsonld-viz が cytoscape-elk で使っているのと同じアルゴリズム・同じ向きなので、
 * 見た目を変えずに操作できるようにできる。
 */
import ELK from 'elkjs/lib/elk.bundled.js'

export interface LayoutNode {
  id: string
  width: number
  height: number
}

export interface LayoutEdge {
  id: string
  source: string
  target: string
}

export async function layoutGraph(
  nodes: LayoutNode[],
  edges: LayoutEdge[],
): Promise<Map<string, { x: number; y: number }>> {
  const elk = new ELK()
  const laid = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '56',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
    },
    children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
    edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
  })

  const positions = new Map<string, { x: number; y: number }>()
  for (const child of laid.children ?? []) {
    if (child.x != null && child.y != null) {
      positions.set(child.id, { x: child.x, y: child.y })
    }
  }
  return positions
}
