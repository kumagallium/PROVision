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

/**
 * 画像が揃うのを待つ上限。16ms 刻みで約 10 秒。
 * 過ぎたら揃わなくても並べる——何も並ばないよりはましである
 */
const IMAGE_PATIENCE = 600

/**
 * 描かれたノードの実寸を DOM から読む。まだ描き終わっていなければ null。
 *
 * **画像の読み込みを待つ。** ノードの高さは `height: auto` の画像で決まるので、
 * 読み込む前に測ると背が低いまま並び、**あとで伸びて下の段と重なる**（実測: 過去の
 * 会話を開くと重なった）。読み込みに失敗した画像も `complete` になるので待ち続けない。
 */
function measureNodes(expected: number, expectedImages: number): LayoutNode[] | null {
  const els = [...document.querySelectorAll<HTMLElement>('.react-flow__node')]
  if (els.length !== expected) return null
  if (expectedImages > 0) {
    const images = [...document.querySelectorAll<HTMLImageElement>('.react-flow__node img')]
    // **src がまだ無い img は complete と報告される**（仕様）。src が付くまでは
    // 読み込み済みと見なさない。付いたあとは complete を待つ（失敗しても complete になる）
    const ready =
      images.length >= expectedImages &&
      images.every((image) => image.getAttribute('src') && image.complete)
    if (!ready) return null
  }
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
  fresh,
  onSelect,
  showArchived,
  archivedCount,
  onToggleArchived,
}: {
  flow: { nodes: FlowNode[]; edges: FlowEdge[] } | null
  current: string | null
  /** 直近の送信で生まれた版（D-028）。印を付けるだけで、位置には触らない */
  fresh: ReadonlySet<string>
  onSelect: (id: string | null) => void
  /** アーカイブした版も出しているか（D-032） */
  showArchived?: boolean
  /** この会話でアーカイブしてある版の数。0 なら切り替えを出さない */
  archivedCount?: number
  onToggleArchived?: () => void
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
  /** 並べたあとの背丈の変化を見張る。画像が遅れて載ると背が伸びる */
  const observer = useRef<ResizeObserver | undefined>(undefined)
  const resizeTimer = useRef<number | undefined>(undefined)
  /** 画面の大きさを測る先。選んだ版が外に出ているかの判定に要る（D-028） */
  const wrapper = useRef<HTMLDivElement | null>(null)

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
    const expectedImages = flow.nodes.filter((n) => n.data.imageUrl !== undefined).length
    let attempts = 0
    let relayouts = 0
    const tick = () => {
      if (cancelled) return
      // 待ちきれなくなったら、画像が揃っていなくても並べる
      const measured = measureNodes(
        flow.nodes.length,
        attempts < IMAGE_PATIENCE ? expectedImages : 0,
      )
      if (!measured) {
        if (attempts++ > IMAGE_PATIENCE + 120) return
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
        /**
         * 並べたあとで背丈が変わったら並べ直す。待ちきれずに並べたときや、
         * 想定外の遅れで伸びたときの受け皿——**重なったまま放置しない**。
         *
         * 時間で見張らない。いつ伸びるか分からないので、**伸びたことを検知する**
         */
        observer.current?.disconnect()
        if (relayouts >= 2) return
        const watch = new ResizeObserver(() => {
          if (cancelled) return
          if (resizeTimer.current !== undefined) window.clearTimeout(resizeTimer.current)
          resizeTimer.current = window.setTimeout(() => {
            if (cancelled) return
            observer.current?.disconnect()
            relayouts += 1
            attempts = 0
            tick()
          }, 120)
        })
        for (const el of document.querySelectorAll('.react-flow__node')) watch.observe(el)
        observer.current = watch
      })
    }
    timer.current = window.setTimeout(tick, 16)

    return () => {
      cancelled = true
      if (timer.current !== undefined) window.clearTimeout(timer.current)
      if (resizeTimer.current !== undefined) window.clearTimeout(resizeTimer.current)
      observer.current?.disconnect()
      observer.current = undefined
    }
  }, [flow, setNodes, setEdges])

  /**
   * 選択と「新」の反映は位置に触らない（並べ直しを起こさないため）。
   *
   * **`toFlow` に混ぜない**のもこのため（D-028）。写しを作り直すと、下の
   * 並べ直しの effect が丸ごと走り、測り直しとレイアウトが毎回やり直しになる
   */
  useEffect(() => {
    setNodes((prev) =>
      prev.map((n) => ({
        ...n,
        selected: n.id === current,
        data: { ...n.data, fresh: fresh.has(n.id) },
      })),
    )
  }, [current, fresh, setNodes])

  /**
   * 選んだ版が画面の外なら、そこへ寄せる（D-028）。
   *
   * **外に出ているときだけ動かす。** 見えているのに動かすと、利用者が自分で
   * 動かした位置を勝手に戻されることになる。倍率も変えない——選び直すたびに
   * 拡大率が変わると、どこを見ているのか分からなくなる
   */
  useEffect(() => {
    if (!current || !laidOut) return
    const view = wrapper.current
    const instance = instanceRef.current
    /**
     * `getNode` ではなく `getInternalNode`。**寸法と絶対位置が確実に入っている**のは
     * こちらだけで、`getNode` が返す版は測る前だと `measured` を持たない（実測: 寄せが
     * 一度も動かなかった）
     */
    const node = instance.getInternalNode(current)
    if (!view || !node?.measured.width || !node.measured.height) return
    const { x, y, zoom } = instance.getViewport()
    const at = node.internals.positionAbsolute
    const left = at.x * zoom + x
    const top = at.y * zoom + y
    const right = left + node.measured.width * zoom
    const bottom = top + node.measured.height * zoom
    const margin = 24
    const outside =
      left < margin ||
      top < margin ||
      right > view.clientWidth - margin ||
      bottom > view.clientHeight - margin
    if (!outside) return
    // duration を付けない。アニメーションは rAF で動くので、隠れたタブでは
    // 一度も進まないまま終わる（実測。上の fitView が同じ理由で付けていない）
    void instance.setCenter(at.x + node.measured.width / 2, at.y + node.measured.height / 2, {
      zoom,
    })
  }, [current, laidOut])

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
    <div
      ref={wrapper}
      style={{
        minWidth: 0,
        borderLeft: '1px solid #e0e5e8',
        height: '100%',
        position: 'relative',
      }}
    >
      {archivedCount !== undefined && archivedCount > 0 && onToggleArchived ? (
        // アーカイブした版はグラフから外れている（D-032）。**在ることは言う**——
        // 黙って消すと、作ったはずの版が失われたように見える
        <button
          type="button"
          onClick={onToggleArchived}
          style={{
            position: 'absolute',
            top: 10,
            right: 12,
            zIndex: 4,
            border: '1px solid #d8dfe3',
            borderRadius: 7,
            background: '#fff',
            padding: '5px 10px',
            fontSize: 11.5,
            color: '#5c6b73',
            cursor: 'pointer',
            boxShadow: '0 1px 3px rgba(0,0,0,.12)',
          }}
        >
          {showArchived ? 'アーカイブを隠す' : `アーカイブ ${archivedCount} 件を表示`}
        </button>
      ) : null}
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
