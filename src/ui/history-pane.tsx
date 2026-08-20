/**
 * 左の面 — これまで作った版を時刻順に並べる。
 *
 * 「いま居る版」の系譜に載っている版だけ色を残し、枝の外は薄くする。
 * どの枝の話をしているのかが、一覧の側でも分かるようにするため。
 */
import type { ProvGraph } from '../prov/graph.js'
import { imageUrlOf } from './graph-adapter.js'
import { PALETTE } from './palette.js'

export function HistoryPane({
  graph,
  current,
  onSelect,
}: {
  graph: ProvGraph | null
  current: string | null
  onSelect: (id: string) => void
}) {
  const activities = graph
    ? [...graph.listActivities()].sort((a, b) =>
        a.startedAtTime.localeCompare(b.startedAtTime),
      )
    : []
  const onPath = new Set(current && graph ? graph.lineage(current).map((a) => a.id) : [])

  return (
    <aside style={{ overflowY: 'auto', padding: '12px 10px', background: '#fff' }}>
      <h1 style={{ fontSize: 13, margin: '2px 4px 10px', color: '#3f4a52' }}>履歴</h1>

      {activities.length === 0 ? (
        <p style={{ fontSize: 12, color: '#7b8892', padding: '0 4px' }}>
          まだ 1 枚もありません。右のチャットに指示を書くと始まります。
        </p>
      ) : null}

      {activities.map((a) => {
        const entity = graph?.getEntity(a.generated)
        const selected = entity?.id === current
        const dim = onPath.size > 0 && !onPath.has(a.id)
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => entity && onSelect(entity.id)}
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 1fr',
              gap: 8,
              width: '100%',
              textAlign: 'left',
              alignItems: 'center',
              padding: 6,
              marginBottom: 4,
              border: selected ? `1.5px solid ${PALETTE.image.main}` : '1px solid transparent',
              borderRadius: 8,
              background: selected ? PALETTE.image.bg : 'transparent',
              cursor: 'pointer',
              opacity: dim ? 0.42 : 1,
              font: 'inherit',
            }}
          >
            {entity && imageUrlOf(entity) ? (
              <img
                src={imageUrlOf(entity)}
                alt=""
                style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 5 }}
              />
            ) : (
              <div style={{ width: 40, height: 40, borderRadius: 5, background: '#eef1f2' }} />
            )}
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: '#2f3a41',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {a.intent ?? a.label}
              </span>
              <span style={{ fontSize: 10, color: '#8b98a1' }}>
                {a.startedAtTime.slice(11, 16)} · seed {a.seed}
              </span>
            </span>
          </button>
        )
      })}
    </aside>
  )
}
