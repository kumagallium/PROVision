/**
 * 左の面 — 会話の一覧。ふつうのチャット AI と同じ並び。
 *
 * 会話は別の語彙で持たない。**根（親を持たない生成）ごとの連結成分がそのまま 1 つの会話**で、
 * グラフから導ける。別に持つと、グラフと食い違ったときにどちらが本当か分からなくなる。
 */
import type { ProvGraph } from '../prov/graph.js'
import { imageUrlOf } from './graph-adapter.js'
import { PALETTE } from './palette.js'
import { ProvImage } from './prov-image.js'

export function SessionPane({
  graph,
  currentRoot,
  onOpen,
  onNew,
  onOpenSettings,
  updateAvailable,
}: {
  graph: ProvGraph | null
  currentRoot: string | undefined
  /** その会話のいちばん新しい版を開く */
  onOpen: (entityId: string) => void
  onNew: () => void
  onOpenSettings: () => void
  updateAvailable: boolean
}) {
  const sessions = graph
    ? graph
        .roots()
        .map((root) => {
          const versions = graph.session(root.id)
          const first = graph.activityThatGenerated(root.id)
          const last = versions[versions.length - 1]
          const lastAt = last
            ? (graph.activityThatGenerated(last.id)?.startedAtTime ?? '')
            : ''
          return { root, versions, title: first?.label ?? root.label, lastAt, last }
        })
        // 新しい会話が上
        .sort((a, b) => b.lastAt.localeCompare(a.lastAt))
    : []

  return (
    <aside
      style={{
        overflowY: 'auto',
        background: '#fff',
        display: 'grid',
        gridTemplateRows: 'auto 1fr',
        minHeight: 0,
      }}
    >
      <div style={{ padding: '10px 10px 6px', display: 'grid', gap: 6 }}>
        <button
          type="button"
          onClick={onOpenSettings}
          style={{
            justifySelf: 'end',
            border: 'none',
            background: 'none',
            color: '#7b8892',
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          ⚙ 設定
          {updateAvailable ? (
            <span
              title="新しいバージョンがあります"
              style={{
                marginLeft: 5,
                padding: '1px 6px',
                borderRadius: 999,
                background: PALETTE.activity.main,
                color: '#fff',
                fontSize: 10,
              }}
            >
              更新あり
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={onNew}
          style={{
            width: '100%',
            padding: '8px 0',
            border: `1px solid ${PALETTE.activity.main}`,
            borderRadius: 8,
            background: '#fff',
            color: PALETTE.activity.text,
            fontSize: 13,
            cursor: 'pointer',
          }}
        >
          ＋ 新しいチャット
        </button>
      </div>

      <div style={{ overflowY: 'auto', padding: '0 8px 12px', position: 'relative' }}>
        {sessions.length === 0 ? (
          <p style={{ fontSize: 12, color: '#7b8892', padding: '0 4px' }}>
            まだ会話がありません。右に指示を書くと始まります。
          </p>
        ) : null}

        {sessions.map(({ root, versions, title, lastAt, last }) => {
          const selected = root.id === currentRoot
          return (
            <button
              key={root.id}
              type="button"
              onClick={() => onOpen(last?.id ?? root.id)}
              style={{
                display: 'grid',
                gridTemplateColumns: '36px 1fr',
                gap: 8,
                width: '100%',
                textAlign: 'left',
                alignItems: 'center',
                padding: 7,
                marginBottom: 3,
                border: selected
                  ? `1.5px solid ${PALETTE.activity.main}`
                  : '1px solid transparent',
                borderRadius: 8,
                background: selected ? PALETTE.activity.bg : 'transparent',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              <ProvImage
                path={imageUrlOf(root)}
                style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 5 }}
              />
              <span style={{ minWidth: 0 }}>
                <span
                  style={{
                    display: 'block',
                    fontSize: 12.5,
                    color: '#2f3a41',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {title}
                </span>
                <span style={{ fontSize: 10, color: '#8b98a1' }}>
                  {versions.length} 版 · {lastAt.slice(5, 10).replace('-', '/')}{' '}
                  {lastAt.slice(11, 16)}
                </span>
              </span>
            </button>
          )
        })}
      </div>
    </aside>
  )
}
