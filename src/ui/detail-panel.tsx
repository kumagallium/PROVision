/**
 * 選んだノードについて Step 3 の問いに答える面。
 *
 *   説明 — どの指示の連なりでこうなったか
 *   再実行 — この絵をもう一度出すのに要る情報（そのまま実行できる形で出す）
 *   横断 — 著者がどの外部データを参照していたか
 */
import type { ProvGraph } from '../prov/graph.js'
import type { GenerationActivity } from '../prov/types.js'
import type { FlowNodeData } from './graph-adapter.js'
import { PALETTE } from './palette.js'

const H: React.CSSProperties = {
  margin: '18px 0 6px',
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: '.04em',
  color: '#3f4a52',
}

const CODE: React.CSSProperties = {
  display: 'block',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-all',
  background: '#f4f6f7',
  border: '1px solid #e0e5e8',
  borderRadius: 6,
  padding: '8px 10px',
  fontSize: 11,
  fontFamily: 'ui-monospace, monospace',
  color: '#2f3a41',
}

function ReproBlock({ activity }: { activity: GenerationActivity }) {
  const lines = [
    `prompt: ${activity.prompt}`,
    `model:  ${activity.model}`,
    `seed:   ${activity.seed}`,
    ...(activity.steps !== undefined ? [`steps:  ${activity.steps}`] : []),
    ...(activity.width !== undefined
      ? [`size:   ${activity.width}x${activity.height ?? activity.width}`]
      : []),
  ]
  return <code style={CODE}>{lines.join('\n')}</code>
}

export function DetailPanel({
  graph,
  data,
}: {
  graph: ProvGraph | null
  data: FlowNodeData | undefined
}) {
  const frame: React.CSSProperties = {
    borderLeft: '1px solid #e0e5e8',
    padding: '16px 18px',
    overflowY: 'auto',
    background: '#fff',
  }

  if (!graph || !data) {
    return (
      <aside style={frame}>
        <p style={{ color: '#7b8892', fontSize: 13 }}>
          ノードを選ぶと、その版の来歴と、再実行に要る情報が出ます。
        </p>
      </aside>
    )
  }

  if (data.kind === 'external') {
    return (
      <aside style={frame}>
        <h2 style={{ fontSize: 15, margin: 0, color: PALETTE.external.text }}>
          参照した外部リソース
        </h2>
        <p style={{ fontSize: 12, color: '#5c6b73' }}>
          著者がこれを見てこの図を作らせた、という記録です。画像生成モデルがこれを
          読んだわけではないので、派生（wasDerivedFrom）の辺は張っていません。
        </p>
        <code style={CODE}>{data.iri}</code>
      </aside>
    )
  }

  // 画像を選んだら、その画像を生んだ Activity を主役にする
  const activity =
    data.kind === 'activity'
      ? data.activity
      : data.entity
        ? graph.activityThatGenerated(data.entity.id)
        : undefined
  const entity =
    data.kind === 'image'
      ? data.entity
      : data.activity
        ? graph.getEntity(data.activity.generated)
        : undefined

  const chain = entity ? graph.lineage(entity.id) : []
  const referenced = [...new Set(chain.flatMap((a) => a.referenced))]

  return (
    <aside style={frame}>
      <h2 style={{ fontSize: 15, margin: 0 }}>{entity?.label ?? data.label}</h2>

      <h3 style={H}>説明 — どの指示でこうなったか</h3>
      <ol style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#2f3a41' }}>
        {chain.map((a) => (
          <li key={a.id} style={{ marginBottom: 4 }}>
            {a.intent ?? <span style={{ color: '#7b8892' }}>（初回の生成）</span>}
            <span style={{ color: '#7b8892' }}> · seed {a.seed}</span>
          </li>
        ))}
      </ol>

      {activity ? (
        <>
          <h3 style={H}>再実行に要る情報</h3>
          <ReproBlock activity={activity} />
        </>
      ) : null}

      {referenced.length > 0 ? (
        <>
          <h3 style={H}>この版が基づく外部データ</h3>
          <p style={{ fontSize: 11, color: '#7b8892', margin: '0 0 6px' }}>
            系譜をさかのぼって集めた参照。asterism 側と繋ぐと、試料・論文・
            インジェスト実行まで届きます。
          </p>
          {referenced.map((iri) => (
            <code key={iri} style={{ ...CODE, marginBottom: 6 }}>
              {iri}
            </code>
          ))}
        </>
      ) : null}

      {entity ? (
        <>
          <h3 style={H}>この画像</h3>
          <code style={CODE}>
            {`sha256: ${entity.digest}\n${entity.location ?? ''}`}
          </code>
        </>
      ) : null}
    </aside>
  )
}
