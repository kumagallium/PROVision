/**
 * いま居る版について、**後から表明する**ための面。
 *
 * ここで入れたものは生成の記録を書き換えない。いつ・誰が言ったかごと、
 * 別の Activity として残る（D-008）。
 *
 *   参照 — この版は、この外部データに基づく（asterism の曲線 IRI など）
 *   掲載 — この版が、この論文の Figure N として載った
 */
import { useState } from 'react'
import type { ProvGraph } from '../prov/graph.js'
import type { ProvJsonLdDocument } from '../prov/jsonld.js'
import { apiFetch } from './api-base.js'
import { PALETTE } from './palette.js'

const FIELD: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid #d8dfe3',
  borderRadius: 7,
  padding: '6px 8px',
  font: 'inherit',
  fontSize: 12,
}

const SMALL_BUTTON = (main: string): React.CSSProperties => ({
  marginTop: 6,
  padding: '6px 12px',
  border: 'none',
  borderRadius: 7,
  background: main,
  color: '#fff',
  fontSize: 12,
  cursor: 'pointer',
})

const H: React.CSSProperties = {
  margin: '12px 0 4px',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: '.04em',
  color: '#3f4a52',
}

export function AssertPanel({
  graph,
  entityId,
  onGraph,
}: {
  graph: ProvGraph | null
  entityId: string
  onGraph: (doc: ProvJsonLdDocument) => void
}) {
  const [refs, setRefs] = useState('')
  const [figureLabel, setFigureLabel] = useState('')
  const [partOf, setPartOf] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rerun, setRerun] = useState<'idle' | 'running' | 'match' | 'differ'>('idle')

  if (!graph) return null
  const existing = graph.referencesOf(entityId)
  const published = graph.publicationsOf(entityId)

  async function post(path: string, body: unknown) {
    setBusy(true)
    setError(null)
    try {
      const res = await apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { graph?: ProvJsonLdDocument; error?: string }
      if (!res.ok || json.error) throw new Error(json.error ?? `失敗（${res.status}）`)
      if (json.graph) onGraph(json.graph)
      return true
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function runRerun() {
    setRerun('running')
    setError(null)
    try {
      const res = await apiFetch('api/rerun', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity: entityId }),
      })
      const json = (await res.json()) as {
        match?: boolean
        graph?: ProvJsonLdDocument
        error?: string
      }
      if (!res.ok || json.error) throw new Error(json.error ?? `失敗（${res.status}）`)
      if (json.graph) onGraph(json.graph)
      setRerun(json.match ? 'match' : 'differ')
    } catch (e: unknown) {
      setRerun('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div>
      <h3 style={H}>再実行</h3>
      <p style={{ fontSize: 11, color: '#7b8892', margin: '0 0 6px' }}>
        記録どおりの prompt / model / seed でもう一度出して、
        <strong>同じ絵になるかを実際に確かめます</strong>。
        一致すればこの版に生成が 1 本増え、食い違えば別の版として残ります。
      </p>
      <button
        type="button"
        disabled={busy || rerun === 'running'}
        onClick={() => void runRerun()}
        style={SMALL_BUTTON(PALETTE.activity.main)}
      >
        {rerun === 'running' ? '再実行中… 2〜3 分' : 'この版を再実行'}
      </button>
      {rerun === 'match' ? (
        <p style={{ fontSize: 11.5, color: PALETTE.image.text, marginTop: 6 }}>
          同じ絵が出ました。この版は再現できます。
        </p>
      ) : null}
      {rerun === 'differ' ? (
        <p style={{ fontSize: 11.5, color: '#a8513f', marginTop: 6 }}>
          違う絵が出ました。別の版として記録しています（隠しません）。
        </p>
      ) : null}

      <h3 style={H}>基づく外部データ</h3>
      <p style={{ fontSize: 11, color: '#7b8892', margin: '0 0 6px' }}>
        著者がこれを見てこの図を作った、という記録。asterism 側と繋ぐと、試料・論文・
        インジェスト実行まで届きます。画像生成モデルが読んだわけではないので、派生の辺は張りません。
      </p>
      {existing.length > 0 ? (
        <ul style={{ margin: '0 0 6px', paddingLeft: 16, fontSize: 11 }}>
          {existing.map((iri) => (
            <li key={iri} style={{ wordBreak: 'break-all', color: PALETTE.external.text }}>
              {iri}
            </li>
          ))}
        </ul>
      ) : null}
      <textarea
        value={refs}
        onChange={(e) => setRefs(e.target.value)}
        rows={2}
        placeholder="IRI を 1 行に 1 つ（例: https://…/resource/curve/1171-318-665）"
        style={FIELD}
      />
      <button
        type="button"
        disabled={busy || refs.trim().length === 0}
        onClick={() => {
          void post('api/reference', {
            entity: entityId,
            referenced: refs.split('\n').map((v) => v.trim()).filter(Boolean),
          }).then((ok) => ok && setRefs(''))
        }}
        style={SMALL_BUTTON(PALETTE.external.main)}
      >
        参照として記録
      </button>

      <h3 style={H}>掲載</h3>
      <p style={{ fontSize: 11, color: '#7b8892', margin: '0 0 6px' }}>
        どの版が、どこに、どの図として載ったか。「掲載されたのはどれか」を後から引けます。
      </p>
      {published.length > 0 ? (
        <ul style={{ margin: '0 0 6px', paddingLeft: 16, fontSize: 11 }}>
          {published.map((f) => (
            <li key={f.id} style={{ wordBreak: 'break-all', color: PALETTE.image.text }}>
              {f.label} — {f.partOf}
            </li>
          ))}
        </ul>
      ) : null}
      <input
        value={figureLabel}
        onChange={(e) => setFigureLabel(e.target.value)}
        placeholder="図版の呼び名（例: Figure 2）"
        style={{ ...FIELD, marginBottom: 6 }}
      />
      <input
        value={partOf}
        onChange={(e) => setPartOf(e.target.value)}
        placeholder="載った先（DOI や URL）"
        style={FIELD}
      />
      <button
        type="button"
        disabled={busy || !figureLabel.trim() || !partOf.trim()}
        onClick={() => {
          void post('api/publication', {
            entity: entityId,
            figureLabel,
            partOf,
          }).then((ok) => {
            if (ok) {
              setFigureLabel('')
              setPartOf('')
            }
          })
        }}
        style={SMALL_BUTTON(PALETTE.image.main)}
      >
        掲載として記録
      </button>

      {error ? (
        <p style={{ fontSize: 11, color: '#a8513f', marginTop: 8 }}>{error}</p>
      ) : null}
    </div>
  )
}
