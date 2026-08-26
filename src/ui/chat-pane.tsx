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
import type { ImageEntity } from '../prov/types.js'
import type { ProvJsonLdDocument } from '../prov/jsonld.js'
import { imageUrlOf } from './graph-adapter.js'
import { PALETTE } from './palette.js'
import { DetailPanel } from './detail-panel.js'
import { AssertPanel } from './assert-panel.js'
import { ProvImage } from './prov-image.js'
import { apiFetch } from './api-base.js'
import { EditRegionDialog } from './edit-region-dialog.js'
import { SourcePicker } from './source-picker.js'
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
  const [routingNotice, setRoutingNotice] = useState<string | null>(null)
  const [editRegionOpen, setEditRegionOpen] = useState(false)
  /** 1 回の送信で出す候補の数（D-018）。**指示から数は読み取らない** */
  const [variants, setVariants] = useState(1)
  /** 材料として足した別の画像（D-021）。いま居る版と合わせて融合する */
  const [extraParents, setExtraParents] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
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
    // 版を移ったら材料も外す。前の版のつもりで足したものが黙って付いてくるのを防ぐ
    setExtraParents([])
    setPickerOpen(false)
  }, [current])

  async function send() {
    const intent = text.trim()
    if (!intent || busy) return
    setBusy(true)
    setError(null)
    setRoutingNotice(null)
    try {
      const res = await apiFetch('api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent,
          ...(current ? { parent: current } : {}),
          ...(variants > 1 ? { variants } : {}),
          ...(extraParents.length > 0 ? { extraParents } : {}),
          ...(editRegion
            ? {
                maskedImage: editRegion.maskedImage,
                maskImage: editRegion.maskImage,
              }
            : {}),
        }),
      })
      const body = (await res.json()) as
        | {
            entity: { id: string }
            graph: ProvJsonLdDocument
            routing?: { mode: 'rules' | 'llm'; tool: string; warning?: string }
          }
        | { error: string }
      if (!res.ok || 'error' in body) {
        throw new Error('error' in body ? body.error : `生成に失敗（${res.status}）`)
      }
      onGraph(body.graph)
      onSelect(body.entity.id)
      if (body.routing) {
        const source = body.routing.mode === 'llm' ? 'AI' : '規則'
        setRoutingNotice(
          body.routing.warning ??
            `${source}が ${body.routing.tool} を選びました。`,
        )
      }
      setEditRegion(null)
      setExtraParents([])
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
          /**
           * 候補を横に並べる。**別の状態は持たず、グラフから導く。**
           *
           * 親があるときは、その親から生えたものを全部（D-018）。後から生やした枝も
           * 同じ列に出る——どちらも「この版から生えたもの」で、区別する記録が無い。
           *
           * 親が無いときは兄弟になりようがないので、**同じ指示から走ったもの**を辿る
           * （D-022）。親画像は無くても、指示は共通の起点として記録されている
           */
          const parent = a.used[0]
          const siblings = parent
            ? (graph?.children(parent) ?? [])
            : a.planId
              ? (graph?.activitiesOfPlan(a.planId) ?? [])
                  .map((act) => graph?.getEntity(act.generated))
                  .filter((e): e is ImageEntity => e !== undefined)
              : []
          const shown = siblings.length > 1 ? siblings : entity ? [entity] : []
          const thumbWidth = shown.length > 1 ? 104 : 220
          /**
           * 候補どうしで**実際に何が違うのか**を出す。intent は揃っていて、違うのは
           * seed と実行された全文（D-018）。全部同じ文なら seed 違いなので、文は出さない
           */
          const promptOf = (id: string) => graph?.activityThatGenerated(id)?.prompt ?? ''
          const promptsDiffer =
            shown.length > 1 && new Set(shown.map((e) => promptOf(e.id))).size > 1
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
              {shown.length > 1 ? (
                <div style={{ fontSize: 10, color: '#8b98a1', marginTop: 6 }}>
                  {parent ? 'この版から生えた' : 'この指示から出た'} {shown.length} 件
                </div>
              ) : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {shown.map((candidate) => {
                  const act = graph?.activityThatGenerated(candidate.id)
                  return (
                    <div key={candidate.id} style={{ width: thumbWidth }}>
                      <button
                        type="button"
                        onClick={() => onSelect(candidate.id)}
                        title={candidate.label}
                        style={{
                          display: 'block',
                          padding: 0,
                          width: '100%',
                          border:
                            candidate.id === current
                              ? `2px solid ${PALETTE.image.main}`
                              : '1px solid #e0e5e8',
                          borderRadius: 10,
                          overflow: 'hidden',
                          cursor: 'pointer',
                          background: 'none',
                        }}
                      >
                        <ProvImage
                          path={imageUrlOf(candidate)}
                          alt={candidate.label}
                          style={{ display: 'block', width: '100%' }}
                        />
                      </button>
                      {shown.length > 1 && act ? (
                        <div style={{ fontSize: 10, color: '#8b98a1', padding: '3px 1px 0' }}>
                          seed {act.seed}
                          {promptsDiffer ? (
                            <div
                              title={act.prompt}
                              style={{
                                marginTop: 2,
                                color: '#5c6b73',
                                display: '-webkit-box',
                                WebkitLineClamp: 3,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}
                            >
                              {act.prompt}
                            </div>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  )
                })}
              </div>
              <div style={{ fontSize: 10, color: '#8b98a1', marginTop: 4 }}>
                seed {a.seed} · {a.model}
                {a.selectedTool ? ` · ${a.selectedTool} (${a.planningMode ?? 'rules'})` : ''}
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
            生成中… 1 枚 1〜2 分かかります（直列に 1 本ずつ流しています）
          </div>
        ) : null}
        {routingNotice ? (
          <div style={{ fontSize: 11, color: '#5c6b73', marginBottom: 4 }}>
            {routingNotice}
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
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              style={{ padding: '5px 8px', fontSize: 11 }}
            >
              材料を足す
            </button>
            {extraParents.length > 0 ? (
              <button
                type="button"
                onClick={() => setExtraParents([])}
                style={{ padding: '5px 8px', fontSize: 11 }}
              >
                材料を外す（{extraParents.length}）
              </button>
            ) : null}
          </div>
        ) : null}
        {extraParents.length > 0 ? (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 8 }}>
            <span style={{ fontSize: 11, color: PALETTE.image.text }}>材料</span>
            {extraParents.map((id) => {
              const picked = graph?.getEntity(id)
              const url = picked ? imageUrlOf(picked) : undefined
              return url ? (
                <ProvImage
                  key={id}
                  path={url}
                  alt={picked?.label}
                  style={{ display: 'block', width: 40, borderRadius: 6 }}
                />
              ) : null
            })}
            <span style={{ fontSize: 11, color: '#7b8892' }}>
              いま居る版と融合します（会話はここから続きます）
            </span>
          </div>
        ) : null}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            fontSize: 11,
            color: '#5c6b73',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            候補
            <select
              value={variants}
              onChange={(e) => setVariants(Number(e.target.value))}
              style={{ font: 'inherit', fontSize: 11, padding: '2px 4px' }}
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <span>
            {variants > 1
              ? 'AI解釈が有効なら方向の違う案、無効なら seed だけ違う案を出します'
              : '同じ指示から複数の案を出したいときは数を上げます'}
          </span>
        </div>
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
      {pickerOpen && graph ? (
        <SourcePicker
          graph={graph}
          exclude={current}
          selected={extraParents}
          max={3}
          onToggle={(id) =>
            setExtraParents((prev) =>
              prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id],
            )
          }
          onClose={() => setPickerOpen(false)}
        />
      ) : null}
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
