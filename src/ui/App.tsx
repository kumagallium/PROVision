import { useCallback, useEffect, useMemo, useState } from 'react'
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
import { SettingsDialog } from './settings-dialog.js'

export function App() {
  const [graph, setGraph] = useState<ProvGraph | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** いま居る版。チャットはここから分岐する */
  const [current, setCurrent] = useState<string | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)

  const applyDoc = useCallback((doc: ProvJsonLdDocument) => {
    setGraph(fromProvJsonLd(doc, DEFAULT_BASE))
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
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [applyDoc])

  useEffect(() => {
    void load()
  }, [load])

  /** 保存先が変わったら、サイドカーを入れ直して読み直す */
  const reloadWorkspace = useCallback(async () => {
    setCurrent(null)
    if (isTauri()) {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('stop_sidecar')
    }
    await load()
  }, [load])

  /** いま話している会話の根。真ん中の面はこの会話だけを描く */
  const currentRoot = useMemo(
    () => (graph && current ? graph.rootOf(current) : undefined),
    [graph, current],
  )

  const flow = useMemo(
    () => (graph ? toFlow(graph, currentRoot) : null),
    [graph, currentRoot],
  )

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
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <ReactFlowProvider>
        <GraphPane flow={flow} current={current} onSelect={setCurrent} />
      </ReactFlowProvider>

      <ChatPane graph={graph} current={current} onGraph={applyDoc} onSelect={setCurrent} />

      {settingsOpen ? (
        <SettingsDialog
          onClose={() => setSettingsOpen(false)}
          onWorkspaceChanged={() => void reloadWorkspace()}
        />
      ) : null}
    </div>
  )
}
