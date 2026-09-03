import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ProvGraph } from '../prov/graph.js'
import { fromProvJsonLd, type ProvJsonLdDocument } from '../prov/jsonld.js'
import { DEFAULT_BASE } from '../prov/iri.js'
import { toFlow } from './graph-adapter.js'
import { GraphPane } from './graph-pane.js'
import { SessionPane } from './session-pane.js'
import { ChatPane } from './chat-pane.js'
import { apiFetch, ensureSidecar, isTauri } from './api-base.js'
import { SettingsDialog, type SettingsTab } from './settings-dialog.js'
import { PALETTE } from './palette.js'
import { checkUpdate, type UpdateInfo } from './updater.js'

export function App() {
  const [graph, setGraph] = useState<ProvGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** いま居る版。チャットはここから分岐する */
  const [current, setCurrent] = useState<string | null>(null)
  /** 開いている設定のタブ。閉じているときは null */
  const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null)
  /**
   * 画像生成の環境がまだ無い（D-029）。生成で失敗する前に、真ん中の面で伝える。
   * 確認に失敗したら黙る——導入できない環境でまで騒がない
   */
  const [setupNeeded, setSetupNeeded] = useState(false)
  /**
   * アーカイブした版も出すか（D-032）。**グラフとチャットで 1 つの切り替え**にする——
   * 別々に持つと、片方で出しているのにもう片方では消えている状態が作れてしまう
   */
  const [showArchived, setShowArchived] = useState(false)
  /** 起動時に自動で確認した結果。見つかったら設定ボタンに印を出す */
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  /**
   * 生成の進み具合。**まだ会話が無いときは真ん中の面が空**なので、
   * ここが動いていないと止まって見える（1 枚 1〜2 分かかる）
   */
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /**
   * 直近の送信の**直前に**あった版（D-028）。ここに無い版が「この送信で生まれたもの」。
   *
   * チャットの中だけで持っていたが、グラフからは同じことが分からなかった。
   * **数えているのは片方だけで、見たいのは両方**なので、持ち主を上へ移す
   */
  const [bornBefore, setBornBefore] = useState<ReadonlySet<string> | null>(null)

  const applyDoc = useCallback((doc: ProvJsonLdDocument) => {
    setGraph(fromProvJsonLd(doc, DEFAULT_BASE))
  }, [])

  const refreshSetup = useCallback(() => {
    return apiFetch('api/setup/status')
      .then(async (r) =>
        r.ok ? ((await r.json()) as { supported: boolean; ready: boolean }) : null,
      )
      .then((status) => setSetupNeeded(Boolean(status && status.supported && !status.ready)))
      .catch(() => setSetupNeeded(false))
  }, [])

  const load = useCallback(() => {
    // デスクトップ版ではまずサイドカーを起こす。ブラウザでは何もしない
    return ensureSidecar()
      .then(() => apiFetch('api/graph'))
      .then(async (r) => {
        if (!r.ok) throw new Error(`グラフが読めない（${r.status}）`)
        return (await r.json()) as ProvJsonLdDocument
      })
      .then(applyDoc)
      .then(() => refreshSetup())
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [applyDoc, refreshSetup])

  useEffect(() => {
    void load()
  }, [load])

  // 起動時に自動で更新を確認する。失敗しても黙って諦める——
  // 配信先が落ちているだけで本体が使えなくなるのは筋が違う
  useEffect(() => {
    void checkUpdate()
      .then(setUpdate)
      .catch(() => undefined)
  }, [])

  /** 保存先が変わったら、サイドカーを入れ直して読み直す */
  const reloadWorkspace = useCallback(async () => {
    setCurrent(null)
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('stop_sidecar')
    }
    await load()
  }, [load])

  /**
   * いま話している会話の根。真ん中の面はこの会話だけを描く。
   *
   * **引けなかったときは直前の根を保つ。** グラフと `current` の更新が一瞬ずれると
   * 根が引けなくなり、真ん中の面が「左から会話を選ぶと…」に戻る——
   * 利用者からは**グラフが消えた**ように見える。会話を選び直すまで空にしない
   */
  const lastRoot = useRef<string | undefined>(undefined)
  const currentRoot = useMemo(() => {
    if (!graph || !current) {
      lastRoot.current = undefined
      return undefined
    }
    const root = graph.rootOf(current)
    if (root) lastRoot.current = root
    return root ?? lastRoot.current
  }, [graph, current])

  /**
   * 真ん中の面は**その会話だけ**を描く。会話を選んでいないときは何も描かない。
   * 全部を一度に出すと、別々の話が 1 枚の絵に混ざって読めなくなる。
   */
  const flow = useMemo(
    () =>
      graph && currentRoot
        ? toFlow(graph, currentRoot, { hideArchived: !showArchived })
        : { nodes: [], edges: [] },
    [graph, currentRoot, showArchived],
  )

  /** この会話でアーカイブしてある版の数。0 なら切り替えを出さない */
  const archivedCount = useMemo(
    () =>
      graph && currentRoot
        ? graph.session(currentRoot).filter((entity) => graph.isArchived(entity.id)).length
        : 0,
    [graph, currentRoot],
  )

  /** この送信で生まれた版。写しには混ぜない——混ぜるとグラフが並び直す（D-028） */
  const fresh = useMemo(() => {
    if (!graph || !bornBefore) return new Set<string>()
    return new Set(
      graph
        .listEntities()
        .filter((entity) => !bornBefore.has(entity.id))
        .map((entity) => entity.id),
    )
  }, [graph, bornBefore])

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: 'system-ui', color: '#a8513f' }}>
        <p>{error}</p>
        <p style={{ color: '#5c6b73' }}>
          <code>pnpm dev</code> でサーバごと起動してください。
        </p>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '250px 1fr 400px',
        height: '100vh',
        fontFamily: 'system-ui, sans-serif',
        background: '#fbfcfc',
      }}
    >
      <SessionPane
        graph={graph}
        currentRoot={currentRoot}
        onOpen={setCurrent}
        onNew={() => setCurrent(null)}
        onOpenSettings={() => setSettingsOpen('general')}
        updateAvailable={update !== null}
        onGraph={applyDoc}
        onDeleted={() => setCurrent(null)}
      />

      <ReactFlowProvider>
        {currentRoot ? (
          <GraphPane
            flow={flow}
            current={current}
            fresh={fresh}
            onSelect={setCurrent}
            showArchived={showArchived}
            archivedCount={archivedCount}
            onToggleArchived={() => setShowArchived(!showArchived)}
          />
        ) : (
          <div
            style={{
              borderLeft: '1px solid #e0e5e8',
              display: 'grid',
              placeItems: 'center',
              color: '#8b98a1',
              fontSize: 13,
              textAlign: 'center',
              padding: 24,
            }}
          >
            {progress ? (
              <div>
                <div style={{ color: '#5b8fb9', fontSize: 14, marginBottom: 6 }}>
                  生成中… {progress.done}/{progress.total} 枚
                </div>
                <div>
                  1 枚 1〜2 分かかります。できたものから右のチャットに出ます。
                </div>
              </div>
            ) : (
              <div>
                <div>左から会話を選ぶと、その会話の来歴が出ます。</div>
                {setupNeeded ? (
                  <div
                    style={{
                      marginTop: 18,
                      padding: '12px 14px',
                      border: `1px solid ${PALETTE.external.main}`,
                      background: PALETTE.external.bg,
                      borderRadius: 8,
                      color: PALETTE.external.text,
                      maxWidth: 420,
                    }}
                  >
                    <div style={{ marginBottom: 8 }}>
                      画像を生成する環境（mflux とモデル）が、まだこの Mac に入っていません。
                    </div>
                    <button
                      type="button"
                      onClick={() => setSettingsOpen('image')}
                      style={{
                        padding: '6px 14px',
                        border: 'none',
                        borderRadius: 7,
                        background: PALETTE.external.main,
                        color: '#fff',
                        fontSize: 12.5,
                        cursor: 'pointer',
                      }}
                    >
                      設定から入れる
                    </button>
                  </div>
                ) : null}
              </div>
            )}
          </div>
        )}
      </ReactFlowProvider>

      <ChatPane
        graph={graph}
        current={current}
        onGraph={applyDoc}
        onSelect={setCurrent}
        onProgress={setProgress}
        bornBefore={bornBefore}
        onBornBefore={setBornBefore}
        onOpenSetup={() => setSettingsOpen('image')}
        onOpenAiSettings={() => setSettingsOpen('ai')}
        showArchived={showArchived}
        onToggleArchived={() => setShowArchived(!showArchived)}
      />

      {settingsOpen ? (
        <SettingsDialog
          initialTab={settingsOpen}
          onClose={() => {
            setSettingsOpen(null)
            // 導入が済んでいれば案内を下げる
            void refreshSetup()
          }}
          onWorkspaceChanged={() => void reloadWorkspace()}
          update={update}
          onUpdateChecked={setUpdate}
        />
      ) : null}
    </div>
  )
}
