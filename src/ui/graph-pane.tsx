/**
 * 真ん中の面 — 来歴グラフ。
 *
 * **並べる前にノードの実寸を測る。** 固定値で ELK に渡すと、指示文が長い生成ノードが
 * 宣言サイズを超えてノード同士が重なる（実使用で発生）。
 *
 * 測り方は DOM から直接読む。React Flow の `useNodesInitialized` は
 * 制御モードでずっと false のままだった（実測）。`offsetWidth/Height` は
 * zoom の transform に影響されないので、こちらのほうが確実。
 *
 * 並べ終わるまでは透明にしておき、(0,0) に積み上がった状態を見せない。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Background,
  Controls,
  ReactFlow,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeMouseHandler,
} from '@xyflow/react'
import type { FlowEdge, FlowNode } from './graph-adapter.js'
import { layoutGraph, type LayoutNode } from './elk-layout.js'
import { nodeTypes } from './nodes.js'
import { EDGE_STYLE } from './palette.js'

/** 描かれたノードの実寸を DOM から読む。まだ描き終わっていなければ null */
function measureNodes(expected: number): LayoutNode[] | null {
  const els = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
  if (els.length !== expected) return null
  const measured: LayoutNode[] = []
  for (const el of els) {
    const id = el.getAttribute('data-id')
    if (!id || el.offsetWidth === 0 || el.offsetHeight === 0) return null
    measured.push({ id, width: el.offsetWidth, height: el.offsetHeight })
  }
  return measured
}

export function GraphPane({
  flow,
  current,
  onSelect,
}: {
  flow: { nodes: FlowNode[]; edges: FlowEdge[] } | null
  current: string | null
  onSelect: (id: string | null) => void
}) {
  // 制御モードでは onNodesChange を渡す。渡さないと選択もドラッグも効かない
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])
  const [laidOut, setLaidOut] = useState(false)
  // useReactFlow() が返す関数は毎レンダー別物になる。effect の依存に入れると
  // レンダーのたびに effect がやり直され、requestAnimationFrame が
  // 発火する前にキャンセルされ続ける（実測。グラフが永久に並ばなかった）
  const instance = useReactFlow()
  const instanceRef = useRef(instance)
  instanceRef.current = instance
  const timer = useRef<number | undefined>(undefined)

  useEffect(() => {
    if (!flow) return
    let cancelled = false
    setLaidOut(false)
    // まず (0,0) に置いて描かせる。描かれた実寸を測ってから並べ直す
    setNodes(flow.nodes.map((n) => ({ ...n, position: { x: 0, y: 0 } })))
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

    // 描画を待つ。画像は幅も高さも固定してあるので、読み込み完了までは待たなくてよい。
    //
    // requestAnimationFrame は使わない。**タブが隠れていると発火しない**ので、
    // 読み込み中に別ウィンドウへ移ると、戻ってきてもグラフが並んでいない（実測）
    let attempts = 0
    const tick = () => {
      if (cancelled) return
      const measured = measureNodes(flow.nodes.length)
      if (!measured) {
        if (attempts++ > 120) return
        timer.current = window.setTimeout(tick, 16)
        return
      }
      void layoutGraph(
        measured,
        flow.edges.map((e) => ({ id: e.id, source: e.source, target: e.target })),
      ).then((positions) => {
        if (cancelled) return
        setNodes((prev) =>
          prev.map((n) => ({ ...n, position: positions.get(n.id) ?? n.position })),
        )
        setLaidOut(true)
        // duration を付けない。アニメーションは内部で rAF を使うので、
        // 隠れたタブでは効かないまま終わる
        window.setTimeout(() => instanceRef.current.fitView({ padding: 0.15 }), 0)
      })
    }
    timer.current = window.setTimeout(tick, 16)

    return () => {
      cancelled = true
      if (timer.current !== undefined) window.clearTimeout(timer.current)
    }
  }, [flow, setNodes, setEdges])

  // 選択の反映は位置に触らない（並べ直しを起こさないため）
  useEffect(() => {
    setNodes((prev) => prev.map((n) => ({ ...n, selected: n.id === current })))
  }, [current, setNodes])

  const onNodeClick: NodeMouseHandler = useCallback(
    (_, node) => {
      if (node.type === 'activity') {
        const generated = (node.data as { activity?: { generated: string } }).activity
          ?.generated
        onSelect(generated ?? null)
      } else if (node.type === 'image') {
        onSelect(node.id)
      }
    },
    [onSelect],
  )

  return (
    <div style={{ minWidth: 0, borderLeft: '1px solid #e0e5e8', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        onNodeClick={onNodeClick}
        minZoom={0.05}
        proOptions={{ hideAttribution: true }}
        style={{ opacity: laidOut ? 1 : 0, transition: 'opacity .15s' }}
      >
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  )
}
