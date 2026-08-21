/**
 * 右の面 — チャット。
 *
 * **やりとりの履歴を別に持たない。** 表示しているのは、いま居る版の系譜そのもの
 * （`graph.lineage()`）である。指示は `provision:intent`、返事は生成された画像。
 * 別ストアを持つと、グラフと食い違ったときにどちらが本当か分からなくなる。
 *
 * 途中の版を選んでから送れば、そこから枝が生える。分岐は特別な操作ではなく、
 * 「どこに居るか」を変えて送るだけで起きる。
 */
import { useEffect, useState } from 'react'
import type { ProvGraph } from '../prov/graph.js'
import type { ProvJsonLdDocument } from '../prov/jsonld.js'
import { imageUrlOf } from './graph-adapter.js'
import { PALETTE } from './palette.js'
import { DetailPanel } from './detail-panel.js'
import { AssertPanel } from './assert-panel.js'
import { ProvImage } from './prov-image.js'
import { apiFetch } from './api-base.js'
import { EditRegionDialog } from './edit-region-dialog.js'
import type { EditRegionSelection } from './edit-region-dialog.js'

interface Props {
  graph: ProvGraph | null
  current: string | null
  onGraph: (doc: ProvJsonLdDocument) => void
  onSelect: (id: string) => void
}

export function ChatPane({ graph, current, onGraph, onSelect }: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editRegionOpen, setEditRegionOpen] = useState(false)
  const [editRegion, setEditRegion] = useState<EditRegionSelection | null>(null)

  const chain = graph && current ? graph.lineage(current) : []
  const children = graph && current ? graph.children(current) : []
  /** いま居る版に子がある = ここへ送ると枝が生える */
  const willBranch = children.length > 0
  const currentEntity = graph && current ? graph.getEntity(current) : undefined
  const currentImageUrl = currentEntity ? imageUrlOf(currentEntity) : undefined

  useEffect(() => {
    setEditRegion(null)
    setEditRegionOpen(false)
  }, [current])

  async function send() {
    const intent = text.trim()
    if (!intent || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch('api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent,
          ...(current ? { parent: current } : {}),
          ...(editRegion
            ? {
                maskedImage: editRegion.maskedImage,
                maskImage: editRegion.maskImage,
              }
            : {}),
        }),
      })
      const body = (await res.json()) as
        | { entity: { id: string }; graph: ProvJsonLdDocument }
        | { error: string }
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `生成に失敗（${res.status}）`)
      }
      onGraph(body.graph)
      onSelect(body.entity.id)
      setEditRegion(null)
      setText('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section
      style={{
        borderLeft: '1px solid #e0e5e8',
        display: 'grid',
        gridTemplateRows: '1fr auto',
        minHeight: 0,
        background: '#fff',
      }}
    >
      <div style={{ overflowY: 'auto', padding: '14px 16px' }}>
        {chain.length === 0 ? (
          <p style={{ fontSize: 12, color: '#7b8892' }}>
            指示を書くと 1 枚目が生まれます。途中の版を選んでから書けば、そこから枝が生えます。
          </p>
        ) : null}

        {chain.map((a) => {
          const entity = graph?.getEntity(a.generated)
          const url = entity ? imageUrlOf(entity) : undefined
          return (
            <div key={a.id} style={{ marginBottom: 16 }}>
              <div
                style={{
                  display: 'inline-block',
                  maxWidth: '85%',
                  padding: '7px 11px',
                  borderRadius: '12px 12px 12px 3px',
                  background: PALETTE.activity.bg,
                  color: PALETTE.activity.text,
                  fontSize: 13,
                }}
              >
                {a.intent ?? <span style={{ color: '#7b8892' }}>（最初の指示）{a.label}</span>}
              </div>
              {url ? (
                <button
                  type="button"
                  onClick={() => entity && onSelect(entity.id)}
                  style={{
                    display: 'block',
                    marginTop: 8,
                    padding: 0,
                    border:
                      entity?.id === current
                        ? `2px solid ${PALETTE.image.main}`
                        : '1px solid #e0e5e8',
                    borderRadius: 10,
                    overflow: 'hidden',
                    cursor: 'pointer',
                    background: 'none',
                  }}
                >
                  <ProvImage
                    path={url}
                    alt={entity?.label}
                    style={{ display: 'block', width: 220 }}
                  />
                </button>
              ) : null}
              <div style={{ fontSize: 10, color: '#8b98a1', marginTop: 4 }}>
                seed {a.seed} · {a.model}
              </div>
            </div>
          )
        })}

        {current && chain.length > 0 ? (
          <details style={{ marginTop: 4 }}>
            <summary style={{ fontSize: 12, color: '#5c6b73', cursor: 'pointer' }}>
              この版の詳細（再実行に要る情報・基づくデータ・掲載）
            </summary>
            <DetailPanel graph={graph} entityId={current} />
            <AssertPanel graph={graph} entityId={current} onGraph={onGraph} />
          </details>
        ) : null}

        {busy ? (
          <div style={{ fontSize: 12, color: '#5b8fb9' }}>
            生成中… 1 枚 2〜3 分かかります（直列に 1 本ずつ流しています）
          </div>
        ) : null}
        {error ? <div style={{ fontSize: 12, color: '#a8513f' }}>{error}</div> : null}
      </div>

      <div style={{ borderTop: '1px solid #e0e5e8', padding: 12 }}>
        {willBranch ? (
          <div style={{ fontSize: 11, color: PALETTE.external.text, marginBottom: 6 }}>
            この版にはすでに続きがあります。ここへ送ると<strong>枝が増えます</strong>
          </div>
        ) : null}
        {currentImageUrl ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setEditRegionOpen(true)}
              style={{ padding: '5px 8px', fontSize: 11 }}
            >
              {editRegion ? '編集範囲を変更' : '編集範囲を指定'}
            </button>
            {editRegion ? (
              <button
                type="button"
                onClick={() => setEditRegion(null)}
                style={{ padding: '5px 8px', fontSize: 11 }}
              >
                指定を解除
              </button>
            ) : null}
            <span style={{ fontSize: 11, color: '#7b8892' }}>
              {editRegion ? '範囲指定済み' : '任意の領域を選べます'}
            </span>
          </div>
        ) : null}
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
          placeholder={current ? 'この版への指示（⌘Enter で送信）' : '最初の指示（⌘Enter で送信）'}
          rows={3}
          style={{
            width: '100%',
            boxSizing: 'border-box',
            resize: 'vertical',
            border: '1px solid #d8dfe3',
            borderRadius: 8,
            padding: 8,
            font: 'inherit',
            fontSize: 13,
          }}
        />
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || text.trim().length === 0}
          style={{
            marginTop: 8,
            width: '100%',
            padding: '8px 0',
            border: 'none',
            borderRadius: 8,
            background: busy ? '#b8c6cf' : PALETTE.activity.main,
            color: '#fff',
            fontSize: 13,
            cursor: busy ? 'default' : 'pointer',
          }}
        >
          {busy ? '生成中…' : willBranch ? 'ここから分岐して生成' : '生成'}
        </button>
      </div>
      </section>
      {editRegionOpen && currentImageUrl ? (
        <EditRegionDialog
          imageUrl={currentImageUrl}
          onCancel={() => setEditRegionOpen(false)}
          onConfirm={(selection) => {
            setEditRegion(selection)
            setEditRegionOpen(false)
          }}
        />
      ) : null}
    </>
  )
}
