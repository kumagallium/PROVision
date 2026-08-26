/**
 * 左の面 — 会話の一覧。ふつうのチャット AI と同じ並び。
 *
 * 会話は別の語彙で持たない。**根（親を持たない生成）ごとの連結成分がそのまま 1 つの会話**で、
 * グラフから導ける。別に持つと、グラフと食い違ったときにどちらが本当か分からなくなる。
 */
import { useRef, useState } from 'react'
import type { ProvGraph } from '../prov/graph.js'
import type { ProvJsonLdDocument } from '../prov/jsonld.js'
import { apiFetch } from './api-base.js'
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
  onGraph,
  onDeleted,
}: {
  graph: ProvGraph | null
  currentRoot: string | undefined
  /** その会話のいちばん新しい版を開く */
  onOpen: (entityId: string) => void
  onNew: () => void
  onOpenSettings: () => void
  updateAvailable: boolean
  onGraph: (doc: ProvJsonLdDocument) => void
  /** 開いている会話が消えたら、選択を外してもらう */
  onDeleted: () => void
}) {
  const [renaming, setRenaming] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  /**
   * 外から画像を持ち込む（D-019）。取り込みは新しい会話の根になる——
   * 親を持たない生成と同じ形にしておかないと、画面に出てこない
   */
  async function importFile(file: File) {
    setImporting(true)
    setImportError(null)
    try {
      const dataUrl = await new Promise<string>((done, fail) => {
        const reader = new FileReader()
        reader.onload = () => done(String(reader.result))
        reader.onerror = () => fail(new Error('ファイルを読めませんでした'))
        reader.readAsDataURL(file)
      })
      const res = await apiFetch('api/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataUrl, fileName: file.name }),
      })
      const json = (await res.json()) as
        | { entity: { id: string }; graph: ProvJsonLdDocument }
        | { error: string }
      if (!res.ok || 'error' in json) {
        throw new Error('error' in json ? json.error : `取り込みに失敗（${res.status}）`)
      }
      onGraph(json.graph)
      onOpen(json.entity.id)
    } catch (e: unknown) {
      setImportError(e instanceof Error ? e.message : String(e))
    } finally {
      setImporting(false)
    }
  }

  async function rename(root: string) {
    const title = draft.trim()
    setRenaming(null)
    if (!title) return
    const res = await apiFetch('api/session/title', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root, title }),
    })
    const json = (await res.json()) as { graph?: ProvJsonLdDocument }
    if (json.graph) onGraph(json.graph)
  }

  async function remove(root: string, title: string) {
    if (!window.confirm(`「${title}」を消します。画像もまとめて消えます。戻せません。`)) return
    const res = await apiFetch('api/session', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ root }),
    })
    const json = (await res.json()) as { graph?: ProvJsonLdDocument }
    if (json.graph) {
      onGraph(json.graph)
      onDeleted()
    }
  }

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
          // 表示名を付けていればそれを使う。無ければ最初の指示（＝実際に打った文）
          const title = graph.titleOf(root.id) ?? first?.label ?? root.label
          return { root, versions, title, lastAt, last }
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
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/bmp,image/tiff"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0]
            // 同じファイルを続けて選べるように値を戻す
            e.target.value = ''
            if (file) void importFile(file)
          }}
        />
        <button
          type="button"
          disabled={importing}
          onClick={() => fileInput.current?.click()}
          style={{
            width: '100%',
            marginTop: 6,
            padding: '8px 0',
            border: '1px solid #d6dde1',
            borderRadius: 8,
            background: '#fff',
            color: '#48565f',
            fontSize: 13,
            cursor: importing ? 'progress' : 'pointer',
          }}
        >
          {importing ? '取り込み中…' : '画像を取り込む'}
        </button>
        {importError ? (
          <p style={{ fontSize: 11, color: '#b4232a', margin: '6px 0 0' }}>{importError}</p>
        ) : null}
      </div>

      <div style={{ overflowY: 'auto', padding: '0 8px 12px', position: 'relative' }}>
        {sessions.length === 0 ? (
          <p style={{ fontSize: 12, color: '#7b8892', padding: '0 4px' }}>
            まだ会話がありません。右に指示を書くと始まります。
          </p>
        ) : null}

        {sessions.map(({ root, versions, title, lastAt, last }) => {
          const selected = root.id === currentRoot
          if (renaming === root.id) {
            return (
              <input
                key={root.id}
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => void rename(root.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void rename(root.id)
                  if (e.key === 'Escape') setRenaming(null)
                }}
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  border: `1.5px solid ${PALETTE.activity.main}`,
                  borderRadius: 8,
                  padding: '8px 7px',
                  font: 'inherit',
                  fontSize: 12.5,
                  marginBottom: 3,
                }}
              />
            )
          }
          return (
            <div key={root.id} style={{ position: 'relative' }}>
            <button
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
            {selected ? (
              <span
                style={{
                  position: 'absolute',
                  right: 8,
                  bottom: 6,
                  display: 'flex',
                  gap: 8,
                }}
              >
                <button
                  type="button"
                  onClick={() => {
                    setDraft(title)
                    setRenaming(root.id)
                  }}
                  style={ROW_ACTION}
                >
                  改名
                </button>
                <button
                  type="button"
                  onClick={() => void remove(root.id, title)}
                  style={{ ...ROW_ACTION, color: '#a8513f' }}
                >
                  削除
                </button>
              </span>
            ) : null}
            </div>
          )
        })}
      </div>
    </aside>
  )
}

const ROW_ACTION: React.CSSProperties = {
  border: 'none',
  background: 'none',
  padding: 0,
  fontSize: 10.5,
  color: '#7b8892',
  cursor: 'pointer',
}
