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
import { fromProvJsonLd } from '../prov/jsonld.js'
import { DEFAULT_BASE } from '../prov/iri.js'
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
import { ArrowDialog } from './arrow-dialog.js'
import { PromptRedoPanel } from './prompt-redo.js'
import type { ArrowSelection } from './arrow-dialog.js'
import type { EditRegionSelection } from './edit-region-dialog.js'

/** 誰がこの一手を決めたか（D-031）。記録の生値は「この版の詳細」に出るので、ここは読める言葉で */
const SMALL_BUTTON: React.CSSProperties = {
  border: '1px solid #d8dfe3',
  borderRadius: 7,
  background: '#fff',
  padding: '5px 10px',
  fontSize: 12,
  cursor: 'pointer',
}

/** 誰がこの一手を決めたか（D-031）。記録の生値は「この版の詳細」に出るので、ここは読める言葉で */
const PLANNING_LABELS: Record<'rules' | 'llm' | 'author', string> = {
  rules: '規則',
  llm: 'AI',
  author: '清書は自分で書いた',
}

interface Props {
  graph: ProvGraph | null
  current: string | null
  onGraph: (doc: ProvJsonLdDocument) => void
  onSelect: (id: string) => void
  /** 直近の送信の直前にあった版。持ち主は App（グラフ側でも要るため / D-028） */
  bornBefore: ReadonlySet<string> | null
  onBornBefore: (ids: ReadonlySet<string>) => void
  /** 生成の進み具合。会話を選んでいないときは真ん中の面がこれを出す */
  onProgress?: (progress: { done: number; total: number } | null) => void
  /** 生成器が無かったとき、設定の「画像生成」を開いてもらう（D-029） */
  onOpenSetup?: () => void
}

export function ChatPane({
  graph,
  current,
  onGraph,
  onSelect,
  onProgress,
  bornBefore,
  onBornBefore,
  onOpenSetup,
}: Props) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** エラーに付いてきた印。文言ではなく、これで導入へ誘導する（D-029） */
  const [errorCode, setErrorCode] = useState<string | null>(null)
  const [routingNotice, setRoutingNotice] = useState<string | null>(null)
  /** よけた版も出すか（D-032）。会話を開き直せば既定（隠す）に戻る */
  const [showArchived, setShowArchived] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const [editRegionOpen, setEditRegionOpen] = useState(false)
  /** 1 回の送信で出す候補の数（D-018）。**指示から数は読み取らない** */
  const [variants, setVariants] = useState(1)
  /** 材料として足した別の画像（D-021）。いま居る版と合わせて融合する */
  const [extraParents, setExtraParents] = useState<string[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  /** 画面で引いた矢印（D-020）。位置は画像の大きさに対する％ */
  const [arrow, setArrow] = useState<ArrowSelection | null>(null)
  const [arrowOpen, setArrowOpen] = useState(false)
  /**
   * 送信を始めた時点で在った版。**これに無いものが、この送信で生まれた版**である。
   * 生成は直列なので、待っている間にグラフは 1 枚ずつ増える
   */
  const [editRegion, setEditRegion] = useState<EditRegionSelection | null>(null)

  /** この送信で生まれた版。**まとめて返るのを待たずに 1 枚ずつ出す** */
  const born =
    busy && graph && bornBefore
      ? graph.listEntities().filter((entity) => !bornBefore.has(entity.id))
      : []
  const chain = graph && current ? graph.lineage(current) : []
  const children = graph && current ? graph.children(current) : []
  /** いま居る版に子がある = ここへ送ると枝が生える */
  const willBranch = children.length > 0
  const currentEntity = graph && current ? graph.getEntity(current) : undefined
  const currentImageUrl = currentEntity ? imageUrlOf(currentEntity) : undefined

  useEffect(() => {
    onProgress?.(busy ? { done: born.length, total: variants } : null)
  }, [busy, born.length, variants, onProgress])

  /** よけた版を出し入れする。**記録は書き換わらない**——表明が 1 本増える（D-032） */
  async function toggleArchive() {
    if (!current || archiving) return
    setArchiving(true)
    setError(null)
    try {
      const response = await apiFetch('api/archive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity: current, archived: graph?.isArchived(current) !== true }),
      })
      const body = (await response.json()) as { graph?: ProvJsonLdDocument; error?: string }
      if (!response.ok || body.error || !body.graph) {
        throw new Error(body.error ?? `よけられませんでした（${response.status}）`)
      }
      onGraph(body.graph)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setArchiving(false)
    }
  }

  useEffect(() => {
    setEditRegion(null)
    setEditRegionOpen(false)
    // 版を移ったら材料も外す。前の版のつもりで足したものが黙って付いてくるのを防ぐ
    setExtraParents([])
    setPickerOpen(false)
    // 別の版へ引いた矢印が黙って付いてこないようにする
    setArrow(null)
    setArrowOpen(false)
  }, [current])

  async function send() {
    const intent = text.trim()
    if (!intent || busy) return
    /**
     * **送信の直前にサーバから取り直す。** 画面のグラフが古いと、前の版まで
     * 「この送信で生まれた」と数えてしまい、進み具合が嘘になる
     */
    const before = await apiFetch('api/graph')
      .then((r) => (r.ok ? (r.json() as Promise<ProvJsonLdDocument>) : null))
      .then((doc) => (doc ? fromProvJsonLd(doc, DEFAULT_BASE) : null))
      .catch(() => null)
    onBornBefore(
      new Set((before ?? graph)?.listEntities().map((entity) => entity.id) ?? []),
    )
    setBusy(true)
    setError(null)
    setErrorCode(null)
    setRoutingNotice(null)
    /**
     * 1 枚できるたびに画面へ出す。サーバは 1 枚ずつ記録して保存するので、
     * 待っている間にグラフを取り直せば途中経過が見える。
     * まとめて返るのを待つと、4 枚で 10 分近く何も出ない。
     *
     * **終わったあとに届いた分は捨てる。** 送信中に投げた取得が最後の応答より遅れて
     * 届くと、**できたばかりの版を含まないグラフで上書きしてしまう**。そうなると
     * いま居る版がグラフから引けなくなり、真ん中の面が空になる
     */
    let finished = false
    const poll = window.setInterval(() => {
      void apiFetch('api/graph')
        .then((r) => (r.ok ? (r.json() as Promise<ProvJsonLdDocument>) : null))
        .then((doc) => {
          if (doc && !finished) onGraph(doc)
        })
        .catch(() => undefined)
    }, 2500)
    try {
      const res = await apiFetch('api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent,
          ...(current ? { parent: current } : {}),
          ...(variants > 1 ? { variants } : {}),
          ...(extraParents.length > 0 ? { extraParents } : {}),
          ...(arrow ? { arrow } : {}),
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
            routing?: {
              mode: 'rules' | 'llm'
              tool: string
              warning?: string
              scope?: 'local' | 'whole'
              scopeSource?: 'planner' | 'rules'
            }
          }
        | { error: string; code?: string }
      if (!res.ok || 'error' in body) {
        if ('error' in body && body.code) setErrorCode(body.code)
        throw new Error('error' in body ? body.error : `生成に失敗（${res.status}）`)
      }
      onGraph(body.graph)
      onSelect(body.entity.id)
      if (body.routing) {
        const source = body.routing.mode === 'llm' ? 'AI' : '規則'
        // 範囲を外したときに、どちらを直せばよいか分かるようにする（D-023）
        const scope =
          body.routing.scope === 'whole'
            ? `全体の作り替えとして扱いました（${body.routing.scopeSource === 'planner' ? 'AI' : '規則'}の判断）。`
            : ''
        setRoutingNotice(
          body.routing.warning ?? `${source}が ${body.routing.tool} を選びました。${scope}`,
        )
      }
      setEditRegion(null)
      setExtraParents([])
      setArrow(null)
      setText('')
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      finished = true
      window.clearInterval(poll)
      setBusy(false)
      // **ここで消さない。** 終わった瞬間に消すと、グラフの「新」の印も同時に
      // 消える（D-028）。次の送信が始まるときに置き換わるので、消す必要も無い
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
          /**
           * よけた版（D-032）は候補の並びから外す。**いま見ている版だけは外さない**——
           * 選んでいるものが消えると、自分がどこに居るのか分からなくなる
           */
          const archivedHere = shown.filter(
            (e) => graph?.isArchived(e.id) === true && e.id !== current,
          )
          const visible = showArchived
            ? shown
            : shown.filter((e) => !archivedHere.some((a) => a.id === e.id))
          const thumbWidth = visible.length > 1 ? 104 : 220
          /**
           * 候補どうしで**実際に何が違うのか**を出す。intent は揃っていて、違うのは
           * seed と実行された全文（D-018）。全部同じ文なら seed 違いなので、文は出さない
           */
          const promptOf = (id: string) => graph?.activityThatGenerated(id)?.prompt ?? ''
          const promptsDiffer =
            visible.length > 1 && new Set(visible.map((e) => promptOf(e.id))).size > 1
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
              {visible.length > 1 ? (
                <div style={{ fontSize: 10, color: '#8b98a1', marginTop: 6 }}>
                  {parent ? 'この版から生えた' : 'この指示から出た'} {visible.length} 件
                </div>
              ) : null}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {visible.map((candidate) => {
                  const act = graph?.activityThatGenerated(candidate.id)
                  const isArchived = graph?.isArchived(candidate.id) === true
                  return (
                    <div key={candidate.id} style={{ width: thumbWidth, opacity: isArchived ? 0.45 : 1 }}>
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
                      {shown.length === 1 && act && act.prompt !== a.intent ? (
                        /**
                         * **実行された全文は毎回ここに出す。** 頼んだこと（intent）と
                         * 実行されたこと（prompt）は別々に記録している（D-003）のに、
                         * 候補が複数のときしか出していなかった。1 枚のときこそ、
                         * 書き直しが入ったかどうかが分からない
                         */
                        <div
                          title={act.prompt}
                          style={{
                            fontSize: 10,
                            color: '#8b98a1',
                            padding: '4px 1px 0',
                            display: '-webkit-box',
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: 'vertical',
                            overflow: 'hidden',
                          }}
                        >
                          {act.prompt}
                        </div>
                      ) : null}
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
              {archivedHere.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setShowArchived(!showArchived)}
                  style={{
                    border: 'none',
                    background: 'none',
                    padding: '4px 0 0',
                    fontSize: 10,
                    color: '#8b98a1',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                  }}
                >
                  {showArchived
                    ? `よけた版 ${archivedHere.length} 件も出しています（隠す）`
                    : `よけた版 ${archivedHere.length} 件を表示`}
                </button>
              ) : null}
              <div style={{ fontSize: 10, color: '#8b98a1', marginTop: 4 }}>
                seed {a.seed} · {a.model}
                {a.selectedTool
                  ? ` · ${a.selectedTool}（${PLANNING_LABELS[a.planningMode ?? 'rules']}）`
                  : ''}
              </div>
            </div>
          )
        })}

        {current && chain.length > 0 ? (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10 }}>
              {/* 気に入らない版は消さずによけておく（D-032）。表明が 1 本増えるだけで戻せる */}
              <button
                type="button"
                onClick={() => void toggleArchive()}
                disabled={busy || archiving}
                style={SMALL_BUTTON}
              >
                {graph?.isArchived(current) ? 'よけたのを戻す' : 'この版をよけておく'}
              </button>
              {graph?.isArchived(current) ? (
                <span style={{ fontSize: 11, color: '#8b98a1' }}>
                  よけてあります。候補の並びから外れ、グラフでは薄く出ます
                </span>
              ) : null}
            </div>
            {/* 清書が効かなかったときに、その場で直して出し直せるようにする（D-031） */}
            <PromptRedoPanel
              graph={graph}
              entityId={current}
              onGraph={onGraph}
              onSelect={onSelect}
              disabled={busy}
            />
            <details style={{ marginTop: 8 }}>
              <summary style={{ fontSize: 12, color: '#5c6b73', cursor: 'pointer' }}>
                この版の詳細（再実行に要る情報・基づくデータ・掲載）
              </summary>
              <DetailPanel graph={graph} entityId={current} />
              <AssertPanel graph={graph} entityId={current} onGraph={onGraph} />
            </details>
          </>
        ) : null}

        {busy ? (
          <div style={{ marginTop: 4 }}>
            <div style={{ fontSize: 12, color: '#5b8fb9' }}>
              生成中… {born.length}/{variants} 枚（1 枚 1〜2 分。直列に 1 本ずつ流しています）
            </div>
            {born.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
                {born.map((entity) => (
                  <ProvImage
                    key={entity.id}
                    path={imageUrlOf(entity)}
                    alt={entity.label}
                    style={{
                      display: 'block',
                      width: born.length > 1 ? 104 : 220,
                      borderRadius: 10,
                      border: '1px solid #e0e5e8',
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        {routingNotice ? (
          <div style={{ fontSize: 11, color: '#5c6b73', marginBottom: 4 }}>
            {routingNotice}
          </div>
        ) : null}
        {error ? (
          <div style={{ fontSize: 12, color: '#a8513f' }}>
            {error}
            {errorCode === 'image-command-missing' && onOpenSetup ? (
              <button
                type="button"
                onClick={onOpenSetup}
                style={{ display: 'block', marginTop: 6, padding: '5px 10px', fontSize: 12 }}
              >
                設定の「画像生成」から入れる
              </button>
            ) : null}
          </div>
        ) : null}
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
              disabled={busy}
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
              disabled={busy}
              onClick={() => setPickerOpen(true)}
              style={{ padding: '5px 8px', fontSize: 11 }}
            >
              材料を足す
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setArrowOpen(true)}
              style={{ padding: '5px 8px', fontSize: 11 }}
            >
              {arrow ? '矢印を引き直す' : '矢印を引く'}
            </button>
            {arrow ? (
              <button
                type="button"
                onClick={() => setArrow(null)}
                style={{ padding: '5px 8px', fontSize: 11 }}
              >
                矢印を消す
              </button>
            ) : null}
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
        {arrow ? (
          <div style={{ fontSize: 11, color: PALETTE.image.text, marginBottom: 8 }}>
            矢印: ({arrow.x1}%, {arrow.y1}%) → ({arrow.x2}%, {arrow.y2}%)
            {arrow.text ? `「${arrow.text}」` : ''}
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
              disabled={busy}
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
          // 生成は直列に 1 本ずつ流す。送れないのに書けると、送ったつもりになる
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send()
          }}
          placeholder={
            busy
              ? '生成が終わるまで待ってください'
              : current
                ? 'この版への指示（⌘Enter で送信）'
                : '最初の指示（⌘Enter で送信）'
          }
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
            background: busy ? '#f4f6f7' : '#fff',
            color: busy ? '#8b98a1' : 'inherit',
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
      {arrowOpen && currentImageUrl ? (
        <ArrowDialog
          imageUrl={currentImageUrl}
          onCancel={() => setArrowOpen(false)}
          onConfirm={(selection) => {
            setArrow(selection)
            setArrowOpen(false)
          }}
        />
      ) : null}
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
