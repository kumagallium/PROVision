import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { FlowNodeData } from './graph-adapter.js'
import { PALETTE } from './palette.js'
import { ProvImage } from './prov-image.js'

const card = (main: string, bg: string, selected: boolean): React.CSSProperties => ({
  border: `1.5px solid ${main}`,
  borderRadius: 10,
  background: bg,
  boxShadow: selected ? `0 0 0 3px ${main}44` : '0 1px 3px rgba(0,0,0,.12)',
  overflow: 'hidden',
  fontSize: 12,
  lineHeight: 1.4,
})

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
      style={{ ...card(c.main, c.bg, selected === true), width: 168 }}
      title={d.label}
    >
      <Handle type="target" position={Position.Top} />
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

/** 生成（prov:Activity）。見出しは意図——「なぜこの版になったか」が一目で要る */
export function ActivityNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const c = PALETTE.activity
  const a = d.activity
  return (
    <div style={{ ...card(c.main, c.bg, selected === true), width: 220 }}>
      <Handle type="target" position={Position.Top} />
      <div style={title(c.text, 3)} title={d.label}>
        {d.label}
      </div>
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
