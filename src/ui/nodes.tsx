import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNodeData } from './graph-adapter.js'
import { PALETTE } from './palette.js'
import { ProvImage } from './prov-image.js'

/**
 * 選択は **寸法を変えずに** 示す（D-028）。枠を太らせると実寸が変わり、
 * 背丈を見張っている ResizeObserver が並べ直しを始める。影なら外へ広がるだけで
 * カードの大きさは 1px も動かない。
 *
 * 白を 1 枚挟んでから色を置くのは、点線の背景や隣のカードと地続きに見えないため。
 */
const card = (main: string, bg: string, selected: boolean): React.CSSProperties => ({
  border: `1.5px solid ${main}`,
  borderRadius: 10,
  background: bg,
  boxShadow: selected
    ? `0 0 0 3px #fff, 0 0 0 6px ${main}, 0 6px 16px rgba(0,0,0,.18)`
    : '0 1px 3px rgba(0,0,0,.12)',
  overflow: 'hidden',
  fontSize: 12,
  lineHeight: 1.4,
  position: 'relative',
})

/**
 * この送信で生まれた版の印（D-028）。**重ねて置く**——カードの中に足すと
 * 背が伸びて、印が付いた瞬間にグラフ全体が並び直す
 */
const FRESH_BADGE: React.CSSProperties = {
  position: 'absolute',
  top: 6,
  right: 6,
  zIndex: 1,
  background: PALETTE.image.main,
  color: '#fff',
  fontSize: 10,
  fontWeight: 700,
  letterSpacing: '.06em',
  padding: '2px 7px',
  borderRadius: 999,
  boxShadow: '0 1px 4px rgba(0,0,0,.25)',
}

/** 見出しは行数で刈る。指示文が段落だとカードが巨大になり、並べようがなくなる */
const title = (text: string, lines = 2): React.CSSProperties => ({
  padding: '6px 10px',
  fontWeight: 600,
  color: text,
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
})

/**
 * 画像（prov:Entity）。**絵だけを出す。**
 *
 * 見出しに指示文を重ねていたが、すぐ上の生成ノードが同じ文を出しているので
 * 二重になっていた。ここで見たいのは「どんな絵になったか」だけ。
 * 文言はホバーで出す。
 */
export function ImageNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const c = PALETTE.image
  return (
    <div
      style={{
        ...card(c.main, c.bg, selected === true),
        width: 168,
        // 別の会話から借りた版（D-021）。この会話には属さないので、実線で描かない
        ...(d.borrowed ? { borderStyle: 'dashed', opacity: 0.75 } : {}),
        /**
         * よけた版（D-032）は**薄くするだけで消さない**。系譜の途中なら派生元でもあり、
         * 消すと子の版が「どこから来たか」を辿れなくなる
         */
        ...(d.archived ? { opacity: 0.35 } : {}),
      }}
      title={
        d.archived
          ? `${d.label}（よけてある）`
          : d.borrowed
            ? `${d.label}（別の会話から材料として使った）`
            : d.label
      }
    >
      <Handle type="target" position={Position.Top} />
      {d.fresh ? <div style={FRESH_BADGE}>新</div> : null}
      {d.archived ? <div style={{ ...FRESH_BADGE, background: '#8b98a1' }}>よけた</div> : null}
      {d.borrowed ? (
        <div style={{ padding: '4px 8px 0', fontSize: 10, color: c.text }}>別の会話から</div>
      ) : null}
      {d.imageUrl ? (
        <ProvImage
          path={d.imageUrl}
          alt={d.label}
          // 正方形に切り抜くと、ワードマークを継ぎ足した縦長の版で下が消える。
          // 縦横比のまま収め、極端に細長い版だけ上限で抑える
          style={{
            display: 'block',
            width: 168,
            height: 'auto',
            maxHeight: 260,
            objectFit: 'contain',
          }}
        />
      ) : (
        // 画像が無いのは記録が壊れているとき。黙って空白にせず、何の版かは言う
        <div style={title(c.text)}>{d.label}</div>
      )}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

/** 清書（実行された全文）。見出しより軽く、行数で刈る。全文はホバーと右の詳細で読める */
const prompt = (lines: number): React.CSSProperties => ({
  padding: '0 10px 6px',
  color: '#3f4a52',
  fontSize: 11.5,
  display: '-webkit-box',
  WebkitLineClamp: lines,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
})

/**
 * 生成（prov:Activity）。見せるのは**実行された全文（清書）**（D-030）。
 *
 * 意図（利用者の生の言葉）を見出しにしていたが、候補は同じ意図から出るので
 * 兄弟の節点が全部同じ文になり、**候補ごとに違うもの（清書と seed）が隠れていた**。
 * 意図は指示の節点（D-022）が出す。指示の節点が無い 1 本だけの送信では、
 * ここに意図も添える——「なぜ」と「何を渡したか」の両方が要る。
 */
export function ActivityNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const c = PALETTE.activity
  const a = d.activity
  // 指示の節点が意図を出しているなら、ここでは繰り返さない。清書が無ければ意図しか無い
  const showIntent = !d.planned || !d.prompt
  const hover = [showIntent ? undefined : d.label, d.prompt].filter(Boolean).join('\n\n') || d.label
  return (
    <div style={{ ...card(c.main, c.bg, selected === true), width: 220 }} title={hover}>
      <Handle type="target" position={Position.Top} />
      {showIntent ? <div style={title(c.text, d.prompt ? 2 : 3)}>{d.label}</div> : null}
      {d.prompt ? <div style={prompt(showIntent ? 3 : 4)}>{d.prompt}</div> : null}
      {a ? (
        <div style={{ padding: '0 10px 8px', color: '#5c6b73', fontSize: 11 }}>
          seed {a.seed} · {a.model}
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

/**
 * 1 回の送信（`prov:Plan`）。**候補が枝分かれする起点**（D-022）。
 * ここから何本走ったかを出す——2 本以上でなければ、この節点は作られない
 */
export function PlanNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const c = PALETTE.plan
  return (
    <div style={{ ...card(c.main, c.bg, selected === true), width: 220 }} title={d.label}>
      <div style={{ padding: '5px 10px 0', color: c.text, fontSize: 10, fontWeight: 700 }}>
        指示
      </div>
      <div style={title(c.text, 3)}>{d.label}</div>
      {d.branches ? (
        <div style={{ padding: '0 10px 8px', color: '#5c6b73', fontSize: 11 }}>
          ここから {d.branches} 本
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

/** 人間が参照した外部リソース。こちらの持ち物ではないので、IRI しか言わない */
export function ExternalNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const c = PALETTE.external
  return (
    <div style={{ ...card(c.main, c.bg, selected === true), width: 200 }}>
      <div style={title(c.text)} title={d.label}>
        {d.label}
      </div>
      <div style={{ padding: '0 10px 8px', color: '#7a5a22', fontSize: 11 }}>
        著者が参照（asterism）
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  )
}

export const nodeTypes = {
  image: ImageNode,
  activity: ActivityNode,
  external: ExternalNode,
  plan: PlanNode,
}
