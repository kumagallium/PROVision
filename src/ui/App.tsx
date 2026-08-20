import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ProvGraph } from '../prov/graph.js'
import { fromProvJsonLd, type ProvJsonLdDocument } from '../prov/jsonld.js'
import { DEFAULT_BASE } from '../prov/iri.js'
import { toFlow } from './graph-adapter.js'
import { layoutGraph } from './elk-layout.js'
import { nodeTypes } from './nodes.js'
import { EDGE_STYLE } from './palette.js'
import { HistoryPane } from './history-pane.js'
import { ChatPane } from './chat-pane.js'

/** ノードの実寸。カードの幅は固定なので、測らずに渡してよい */
const SIZE: Record<string, { width: number; height: number }> = {
  image: { width: 168, height: 196 },
  activity: { width: 220, height: 58 },
  external: { width: 200, height: 54 },
}

export function App() {
  const [graph, setGraph] = useState<ProvGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [nodes, setNodes] = useState<Node[]>([])
  const [edges, setEdges] = useState<Edge[]>([])
  /** いま居る版。チャットはここから分岐する */
  const [current, setCurrent] = useState<string | null>(null)

  const applyDoc = useCallback((doc: ProvJsonLdDocument) => {
    setGraph(fromProvJsonLd(doc, DEFAULT_BASE))
  }, [])

  useEffect(() => {
    fetch('/api/graph')
      .then(async (r) => {
        if (!r.ok) throw new Error(`グラフが読めない（${r.status}）`)
        return (await r.json()) as ProvJsonLdDocument
      })
      .then(applyDoc)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [applyDoc])

  const flow = useMemo(() => (graph ? toFlow(graph) : null), [graph])

  useEffect(() => {
    if (!flow) return
    let cancelled = false
    void layoutGraph(
      flow.nodes.map((n) => ({ id: n.id, ...SIZE[n.type]! })),
      flow.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
    ).then((positions) => {
      if (cancelled) return
      setNodes(
        flow.nodes.map((n) => ({
          ...n,
          selected: n.id === current,
          position: positions.get(n.id) ?? n.position,
        })),
      )
      setEdges(
        flow.edges.map((e) => {
          const style = EDGE_STYLE[e.data.kind]
          return {
            ...e,
            style: {
              stroke: style.stroke,
              strokeWidth: 1.5,
              ...(style.dash ? { strokeDasharray: style.dash } : {}),
            },
          }
        }),
      )
    })
    return () => {
      cancelled = true
    }
  }, [flow, current])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      // 生成ノードを選んだら、それが生んだ画像を「いま居る版」にする
      if (node.type === 'activity') {
        const activity = graph?.getActivity(node.id)
        setCurrent(activity?.generated ?? null)
      } else if (node.type === 'image') {
        setCurrent(node.id)
      }
    },
    [graph],
  )

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#a8513f' }}>
        <p>{error}</p>
        <p style={{ color: '#5c6b73' }}>
          <code>pnpm dev</code> でサーバごと起動してください。
        </p>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr 400px',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        background: '#fbfcfc',
      }}
    >
      <HistoryPane graph={graph} current={current} onSelect={setCurrent} />

      <div style={{ minWidth: 0, borderLeft: '1px solid #e0e5e8' }}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodeClick={onNodeClick}
          fitView
          minZoom={0.1}
          proOptions={{ hideAttribution: true }}
        >
          <Background />
          <Controls />
        </ReactFlow>
      </div>

      <ChatPane graph={graph} current={current} onGraph={applyDoc} onSelect={setCurrent} />
    </div>
  )
}
