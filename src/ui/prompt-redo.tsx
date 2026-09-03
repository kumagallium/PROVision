/**
 * 清書を直して出し直す（D-031）。
 *
 * **ここに書いた文がそのまま画像モデルへ渡る。** 書き直しは入らない——
 * 通すと、手で書いた文が書き直されて「自分で書いた」が嘘になる。
 *
 * seed は既定で据え置く。変えると、絵が変わった理由が清書か seed か分からなくなる。
 */
import { useEffect, useRef, useState } from 'react'
import type { ProvGraph } from '../prov/graph.js'
import type { ProvJsonLdDocument } from '../prov/jsonld.js'
import { apiFetch } from './api-base.js'
import { executedPromptOf } from './graph-adapter.js'
import { PALETTE } from './palette.js'

interface Props {
  graph: ProvGraph | null
  /** いま見ている版 */
  entityId: string | null
  onGraph: (doc: ProvJsonLdDocument) => void
  onSelect: (id: string) => void
  /** 生成が走っている間は出し直しを受けない（直列に捌くので待たせるだけになる） */
  disabled?: boolean
}

const BUTTON: React.CSSProperties = {
  border: '1px solid #d8dfe3',
  borderRadius: 7,
  background: '#fff',
  padding: '5px 10px',
  fontSize: 12,
  cursor: 'pointer',
}

/** seed を変えるときの値。記録に残るので、こちらで作っても再現には差し支えない */
function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31)
}

export function PromptRedoPanel({ graph, entityId, onGraph, onSelect, disabled }: Props) {
  const activity = graph && entityId ? graph.activityThatGenerated(entityId) : undefined
  const prompt = activity ? executedPromptOf(activity) : undefined
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [newSeed, setNewSeed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /**
   * 出し直した結果の知らせ。**どの版についての知らせかを持たせる**——
   * 出し直すと画面はその版へ移るので、版で消す作りだと自分の知らせを自分で消してしまう
   */
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null)
  const box = useRef<HTMLDivElement | null>(null)

  /**
   * 版を移ったら閉じる。開いたままにすると、**前の版の清書をいま見ている版へ送る**——
   * 画面には直したつもりの文が残っているので、取り違えても気づけない
   */
  useEffect(() => {
    setOpen(false)
    setError(null)
  }, [entityId])

  // 開いた先が画面の外だと、押しても何も起きていないように見える（下は会話の続き）
  useEffect(() => {
    if (open) box.current?.scrollIntoView({ block: 'nearest' })
  }, [open])

  if (!activity || !prompt || !entityId) return null

  async function submit() {
    const text = draft.trim()
    if (!text || busy) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const response = await apiFetch('api/regenerate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          entity: entityId,
          prompt: text,
          ...(newSeed ? { seed: randomSeed() } : {}),
        }),
      })
      const body = (await response.json()) as {
        entity?: { id: string }
        graph?: ProvJsonLdDocument
        warning?: string
        error?: string
      }
      if (!response.ok || body.error || !body.entity || !body.graph) {
        throw new Error(body.error ?? `出し直しに失敗（${response.status}）`)
      }
      onGraph(body.graph)
      onSelect(body.entity.id)
      setOpen(false)
      setNotice({
        id: body.entity.id,
        text: body.warning ?? '出し直しました。元の版の隣に並びます',
      })
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={box} style={{ marginTop: 8 }}>
      {open ? (
        <div
          style={{
            border: `1px solid ${PALETTE.activity.main}`,
            background: PALETTE.activity.bg,
            borderRadius: 8,
            padding: 10,
          }}
        >
          <div style={{ fontSize: 11, color: PALETTE.activity.text, fontWeight: 700 }}>
            清書を直して出し直す
          </div>
          <p style={{ fontSize: 11, color: '#5c6b73', margin: '4px 0 6px' }}>
            ここに書いた文が<strong>そのまま</strong>画像モデルへ渡ります。書き直しは入りません。
            手（{activity.selectedTool ?? '生成'}）と入力画像は、この版の記録から引き継ぎます。
          </p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            rows={8}
            style={{
              width: '100%',
              boxSizing: 'border-box',
              border: '1px solid #d8dfe3',
              borderRadius: 7,
              padding: '7px 9px',
              fontSize: 11.5,
              fontFamily: 'ui-monospace, monospace',
              lineHeight: 1.5,
              resize: 'vertical',
            }}
          />
          <p style={{ fontSize: 11, color: '#5c6b73', margin: '6px 0' }}>
            部分だけを描かせたいときは、<strong>全体の名前を主語にしない</strong>のが効きます
            （実測）。「octopus tentacle」と書くとタコ全体が出るので、足の形と吸盤を描写して、
            「no octopus, no head, no body」と<strong>無いことも</strong>書きます。
          </p>
          <label
            style={{
              display: 'flex',
              gap: 6,
              // 折り返しても文がばらけないよう、文は 1 つの塊として置く
              alignItems: 'flex-start',
              fontSize: 11.5,
              margin: '6px 0',
            }}
          >
            <input
              type="checkbox"
              checked={newSeed}
              onChange={(e) => setNewSeed(e.target.checked)}
              disabled={busy}
              style={{ marginTop: 2 }}
            />
            <span>
              seed も変える（既定は同じ seed のまま。<strong>言い回しの差だけ</strong>
              を見られます）
            </span>
          </label>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || disabled === true || !draft.trim()}
              style={{
                ...BUTTON,
                border: 'none',
                background: PALETTE.activity.main,
                color: '#fff',
                padding: '6px 14px',
              }}
            >
              {busy ? '出し直しています… 1〜2 分' : '出し直す'}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy} style={BUTTON}>
              やめる
            </button>
          </div>
          {error ? (
            <p style={{ fontSize: 11.5, color: '#a8513f', margin: '8px 0 0' }}>{error}</p>
          ) : null}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(prompt!)
            setNotice(null)
            setOpen(true)
          }}
          disabled={disabled === true}
          style={BUTTON}
        >
          清書を直して出し直す
        </button>
      )}
      {!open && notice && notice.id === entityId ? (
        <p style={{ fontSize: 11.5, color: '#5c6b73', margin: '6px 0 0' }}>{notice.text}</p>
      ) : null}
    </div>
  )
}
