/**
 * 材料にする別の画像を選ぶ（D-021）。
 *
 * **会話をまたいで選べる**のが肝。融合の相手は別の会話にあることが多く、
 * いまの会話に閉じると使いどころが無い。
 *
 * 選んだ画像は `prov:used` に入り、利用者が居た版が `provision:branchedFrom` になる。
 * 会話は分岐元をたどるので、**別の会話から借りても会話が合流しない**。
 */
import type { ProvGraph } from '../prov/graph.js'
import { imageUrlOf } from './graph-adapter.js'
import { PALETTE } from './palette.js'
import { ProvImage } from './prov-image.js'

export function SourcePicker({
  graph,
  exclude,
  selected,
  max,
  onToggle,
  onClose,
}: {
  graph: ProvGraph
  /** いま居る版。材料には選べない（自分と融合しても意味が無い） */
  exclude: string | null
  selected: readonly string[]
  max: number
  onToggle: (entityId: string) => void
  onClose: () => void
}) {
  const sessions = graph.roots().map((root) => ({
    title: graph.titleOf(root.id) ?? graph.activityThatGenerated(root.id)?.label ?? root.label,
    versions: graph.session(root.id).filter((entity) => entity.id !== exclude),
  }))

  return (
    <div
      role="dialog"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,28,34,.45)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#fff',
          borderRadius: 12,
          width: 'min(720px, 92vw)',
          maxHeight: '82vh',
          overflowY: 'auto',
          padding: 16,
        }}
      >
        <h2 style={{ fontSize: 15, margin: '0 0 4px' }}>材料にする画像を選ぶ</h2>
        <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 12px' }}>
          いま居る版と合わせて融合します。<strong>別の会話からも選べます。</strong>
          選んだ画像は来歴に材料として残り、会話は
          <strong>いま居る版から続きます</strong>（合流しません）。あと {max - selected.length} 枚。
        </p>

        {sessions.every((s) => s.versions.length === 0) ? (
          <p style={{ fontSize: 12, color: '#7b8892' }}>選べる画像がまだありません。</p>
        ) : null}

        {sessions.map((session) =>
          session.versions.length === 0 ? null : (
            <div key={session.title} style={{ marginBottom: 14 }}>
              <div
                style={{
                  fontSize: 11,
                  color: '#5c6b73',
                  marginBottom: 6,
                  display: '-webkit-box',
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {session.title}
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {session.versions.map((entity) => {
                  const picked = selected.includes(entity.id)
                  const full = !picked && selected.length >= max
                  return (
                    <button
                      key={entity.id}
                      type="button"
                      disabled={full}
                      onClick={() => onToggle(entity.id)}
                      title={entity.label}
                      style={{
                        padding: 0,
                        border: picked
                          ? `2px solid ${PALETTE.image.main}`
                          : '1px solid #e0e5e8',
                        borderRadius: 8,
                        overflow: 'hidden',
                        background: 'none',
                        cursor: full ? 'not-allowed' : 'pointer',
                        opacity: full ? 0.4 : 1,
                      }}
                    >
                      <ProvImage
                        path={imageUrlOf(entity)}
                        alt={entity.label}
                        style={{ display: 'block', width: 84 }}
                      />
                    </button>
                  )
                })}
              </div>
            </div>
          ),
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
          <button type="button" onClick={onClose} style={{ padding: '7px 14px', fontSize: 13 }}>
            閉じる
          </button>
        </div>
      </div>
    </div>
  )
}
