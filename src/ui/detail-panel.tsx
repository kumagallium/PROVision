/**
 * いま居る版について、Step 3 の問いに答える面。
 *
 *   再実行 — この絵をもう一度出すのに要る情報
 *   横断 — 著者がどの外部データを参照していたか（asterism 側と繋ぐと論文まで届く）
 *   同一性 — 内容ハッシュ。これが Entity の IRI を決めている
 */
import type { ProvGraph } from '../prov/graph.js'

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
  marginBottom: 8,
}

const H: React.CSSProperties = {
  margin: '12px 0 5px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.04em',
  color: '#3f4a52',
}

export function DetailPanel({
  graph,
  entityId,
}: {
  graph: ProvGraph | null
  entityId: string | null
}) {
  if (!graph || !entityId) return null
  const entity = graph.getEntity(entityId)
  const activity = graph.activityThatGenerated(entityId)
  if (!entity || !activity) return null

  const published = graph.publicationsOf(entityId)

  return (
    <div>
      <h3 style={H}>再実行に要る情報</h3>
      <code style={CODE}>
        {[
          `prompt: ${activity.prompt}`,
          `model:  ${activity.model}`,
          `seed:   ${activity.seed}`,
          ...(activity.steps !== undefined ? [`steps:  ${activity.steps}`] : []),
          ...(activity.width !== undefined
            ? [`size:   ${activity.width}x${activity.height ?? activity.width}`]
            : []),
        ].join('\n')}
      </code>

      {published.length > 0 ? (
        <>
          <h3 style={H}>掲載</h3>
          {published.map((f) => (
            <code key={f.id} style={CODE}>{`${f.label}\n${f.partOf}`}</code>
          ))}
        </>
      ) : null}

      <h3 style={H}>この画像</h3>
      <code style={CODE}>{`sha256: ${entity.digest}`}</code>
    </div>
  )
}
