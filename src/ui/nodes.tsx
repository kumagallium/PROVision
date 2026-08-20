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

const title = (text: string): React.CSSProperties => ({
  padding: '6px 10px',
  fontWeight: 600,
  color: text,
})

/** 画像（prov:Entity）。中身が見えないと版を見分けられないので必ずサムネイルを出す */
export function ImageNode({ data, selected }: NodeProps) {
  const d = data as FlowNodeData
  const c = PALETTE.image
  return (
    <div style={{ ...card(c.main, c.bg, selected === true), width: 168 }}>
      <Handle type="target" position={Position.Top} />
      <ProvImage
        path={d.imageUrl}
        alt={d.label}
        style={{ display: 'block', width: 168, height: 168, objectFit: 'cover' }}
      />
      <div style={title(c.text)}>{d.label}</div>
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
      <div style={title(c.text)}>{d.label}</div>
      {a ? (
        <div style={{ padding: '0 10px 8px', color: '#5c6b73', fontSize: 11 }}>
          seed {a.seed} · {a.model}
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
      <div style={title(c.text)}>{d.label}</div>
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
}
