/**
 * 設定 — 保存先と identity。
 *
 * 保存先の既定は **Documents/PROVision**。Application Support に隠すと、
 * 利用者が中身（グラフの JSON-LD と画像）を見にいけない。この道具の成果物は
 * 書き出したファイルそのものなので、手の届く場所に置く。
 *
 * 保存先を変えても**中身は移さない**。黙って動かすと、どちらが本物か分からなくなる。
 */
import { useEffect, useRef, useState } from 'react'
import { AI_PROVIDERS } from '../ai/provider.js'
import { apiFetch, isTauri } from './api-base.js'
import { PALETTE } from './palette.js'
import { appVersion, checkUpdate, installAndRelaunch, type UpdateInfo } from './updater.js'

interface WorkspaceInfo {
  current: string
  default: string
  custom: boolean
}

interface Identity {
  name: string
  email: string
}

type AiProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible'

interface RegisteredAiModel {
  id: string
  name: string
  provider: AiProvider
  modelId: string
  apiBase: string
  hasApiKey: boolean
}

interface AiModelRegistry {
  enabled: boolean
  selectedModelId: string
  models: RegisteredAiModel[]
  keyStorage: 'keychain' | 'memory'
}

interface AiModelDraft {
  name: string
  provider: 'anthropic' | 'openai' | 'google' | 'openai-compatible'
  modelId: string
  apiBase: string
}

const EMPTY_AI_DRAFT: AiModelDraft = {
  name: '',
  provider: 'openai-compatible',
  modelId: '',
  apiBase: 'http://127.0.0.1:11434/v1',
}

type SettingsTab = 'general' | 'ai' | 'about'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: '一般' },
  { id: 'ai', label: 'AI' },
  { id: 'about', label: 'アプリ情報' },
]

const LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#3f4a52',
  margin: '16px 0 6px',
}

const INPUT: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  border: '1px solid #d8dfe3',
  borderRadius: 8,
  padding: '8px 10px',
  font: 'inherit',
  fontSize: 13,
}

const FIELD_LABEL: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: '#3f4a52',
  margin: '12px 0 6px',
}

const MODE_BUTTON = (active: boolean): React.CSSProperties => ({
  flex: 1,
  padding: '7px 10px',
  border: `1px solid ${active ? PALETTE.image.main : '#d8dfe3'}`,
  borderRadius: 7,
  background: active ? PALETTE.image.bg : '#fff',
  color: active ? PALETTE.image.text : '#64727b',
  fontSize: 12,
  fontWeight: active ? 700 : 500,
  cursor: 'pointer',
})

export function SettingsDialog({
  onClose,
  onWorkspaceChanged,
  update,
  onUpdateChecked,
}: {
  onClose: () => void
  /** 保存先が変わったら、サイドカーを入れ直してグラフを読み直してもらう */
  onWorkspaceChanged: () => void
  /** 起動時の自動確認で見つかっていた更新（無ければ null） */
  update: UpdateInfo | null
  onUpdateChecked: (update: UpdateInfo | null) => void
}) {
  const [tab, setTab] = useState<SettingsTab>('general')
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [identity, setIdentity] = useState<Identity>({ name: '', email: '' })
  const [forbidSynthesis, setForbidSynthesis] = useState(false)
  const [saved, setSaved] = useState(false)
  const [aiRegistry, setAiRegistry] = useState<AiModelRegistry | null>(null)
  const [plannerDraft, setPlannerDraft] = useState({ enabled: false, selectedModelId: '' })
  const [aiDraft, setAiDraft] = useState<AiModelDraft>({ ...EMPTY_AI_DRAFT })
  const [connectionMode, setConnectionMode] = useState<'existing' | 'new'>('new')
  const [sourceModelId, setSourceModelId] = useState('')
  const [showAddModel, setShowAddModel] = useState(false)
  const [editingModelId, setEditingModelId] = useState('')
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const [aiApiKey, setAiApiKey] = useState('')
  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [modelsState, setModelsState] = useState<'idle' | 'loading' | 'loaded'>('idle')
  const [modelsError, setModelsError] = useState<string | null>(null)
  const modelRequest = useRef<AbortController | null>(null)
  const testRequest = useRef<AbortController | null>(null)
  const [aiState, setAiState] = useState<
    'idle' | 'saving' | 'saved' | 'testing' | 'ok' | 'deleting'
  >('idle')
  const [error, setError] = useState<string | null>(null)
  const [version, setVersion] = useState('')
  const [updateState, setUpdateState] = useState<
    'idle' | 'checking' | 'none' | 'installing'
  >('idle')
  const [progress, setProgress] = useState(0)

  useEffect(() => {
    void appVersion().then(setVersion)

    void apiFetch('api/policy')
      .then((r) => r.json() as Promise<{ forbidSynthesis?: boolean }>)
      .then((p) => setForbidSynthesis(p.forbidSynthesis === true))
      .catch(() => undefined)
    void apiFetch('api/identity')
      .then((r) => r.json())
      .then((v: Identity) => setIdentity(v))
      .catch(() => undefined)

    void apiFetch('api/ai/models')
      .then(async (response) => {
        const value = (await response.json()) as AiModelRegistry & { error?: string }
        if (!response.ok) throw new Error(value.error ?? 'AIモデル設定を読めません')
        setAiRegistry(value)
        setPlannerDraft({
          enabled: value.enabled,
          selectedModelId: value.selectedModelId,
        })
        const source = value.models.find((model) => model.id === value.selectedModelId)
        if (source) {
          setConnectionMode('existing')
          setSourceModelId(source.id)
          setAiDraft({
            name: '',
            provider: source.provider,
            modelId: '',
            apiBase: source.apiBase,
          })
        }
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

    if (!isTauri()) return
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<WorkspaceInfo>('get_workspace_root'))
      .then(setWorkspace)
      .catch((e: unknown) => setError(String(e)))
  }, [])

  useEffect(
    () => () => {
      modelRequest.current?.abort()
      testRequest.current?.abort()
    },
    [],
  )

  async function pickFolder() {
    if (!isTauri()) return
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const picked = await invoke<string | null>('pick_workspace_root')
      if (!picked) return
      setWorkspace(await invoke<WorkspaceInfo>('set_workspace_root', { path: picked }))
      onWorkspaceChanged()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function resetFolder() {
    if (!isTauri()) return
    const { invoke } = await import('@tauri-apps/api/core')
    setWorkspace(await invoke<WorkspaceInfo>('set_workspace_root', { path: null }))
    onWorkspaceChanged()
  }

  async function runCheck() {
    setUpdateState('checking')
    setError(null)
    try {
      const found = await checkUpdate()
      onUpdateChecked(found)
      setUpdateState(found ? 'idle' : 'none')
    } catch (e: unknown) {
      setUpdateState('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function runInstall() {
    setUpdateState('installing')
    setError(null)
    try {
      await installAndRelaunch((done, total) =>
        setProgress(total ? Math.round((done / total) * 100) : 0),
      )
    } catch (e: unknown) {
      setUpdateState('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function saveIdentity() {
    const res = await apiFetch('api/identity', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(identity),
    })
    if (res.ok) {
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    }
  }

  function resetModelDiscovery(models: string[] = []) {
    modelRequest.current?.abort()
    modelRequest.current = null
    resetConnectionTest()
    setAvailableModels(models)
    setModelsState('idle')
    setModelsError(null)
  }

  function resetConnectionTest() {
    testRequest.current?.abort()
    testRequest.current = null
    setAiState('idle')
  }

  function useExistingConnection(id: string) {
    const source = aiRegistry?.models.find((model) => model.id === id)
    setConnectionMode('existing')
    setSourceModelId(id)
    setAiApiKey('')
    setAiDraft({
      name: '',
      provider: source?.provider ?? 'openai-compatible',
      modelId: '',
      apiBase: source?.apiBase ?? 'http://127.0.0.1:11434/v1',
    })
    resetModelDiscovery()
  }

  /** 登録済みモデルの値をフォームへ入れて編集に入る。APIキーは伏せたまま、入れ直しだけできる */
  function editExistingModel(id: string) {
    const model = aiRegistry?.models.find((item) => item.id === id)
    if (!model) return
    setEditingModelId(id)
    setShowAddModel(true)
    setDeleteConfirm(null)
    setConnectionMode('new')
    setSourceModelId('')
    setAiApiKey('')
    setAiDraft({
      name: model.name,
      provider: model.provider,
      modelId: model.modelId,
      apiBase: model.apiBase,
    })
    resetModelDiscovery()
  }

  function useNewConnection() {
    setConnectionMode('new')
    setSourceModelId('')
    setAiApiKey('')
    setAiDraft({ ...EMPTY_AI_DRAFT })
    resetModelDiscovery()
  }

  async function savePlannerSelection() {
    if (!aiRegistry) return
    testRequest.current?.abort()
    testRequest.current = null
    setAiState('saving')
    setError(null)
    try {
      const response = await apiFetch('api/ai/planner', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: plannerDraft.enabled,
          selectedModelId: plannerDraft.selectedModelId,
        }),
      })
      const value = (await response.json()) as AiModelRegistry & { error?: string }
      if (!response.ok) throw new Error(value.error ?? '解釈に使うモデルを保存できません')
      setAiRegistry(value)
      setPlannerDraft({
        enabled: value.enabled,
        selectedModelId: value.selectedModelId,
      })
      setAiState('saved')
    } catch (e: unknown) {
      setAiState('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function addAiModel() {
    setAiState('saving')
    setError(null)
    try {
      const response = await apiFetch('api/ai/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...aiDraft,
          ...(aiApiKey.trim() ? { apiKey: aiApiKey } : {}),
          ...(editingModelId ? { replaceId: editingModelId } : {}),
        }),
      })
      const value = (await response.json()) as AiModelRegistry & { error?: string }
      if (!response.ok) throw new Error(value.error ?? 'AIモデルを登録できません')
      setAiRegistry(value)
      setPlannerDraft({
        enabled: value.enabled,
        selectedModelId: value.selectedModelId,
      })
      setEditingModelId('')
      setShowAddModel(false)
      setAiApiKey('')
      setAvailableModels([])
      setAiState('idle')
    } catch (e: unknown) {
      setAiState('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function deleteAiModel(id: string) {
    setAiState('deleting')
    setError(null)
    try {
      const response = await apiFetch(`api/ai/models/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      })
      const value = (await response.json()) as AiModelRegistry & { error?: string }
      if (!response.ok) throw new Error(value.error ?? 'AIモデルを削除できません')
      setAiRegistry(value)
      setPlannerDraft({
        enabled: value.enabled,
        selectedModelId: value.selectedModelId,
      })
      if (sourceModelId === id) {
        const next = value.models.find((model) => model.id === value.selectedModelId)
        if (next) useExistingConnection(next.id)
        else useNewConnection()
      }
      setAiState('idle')
    } catch (e: unknown) {
      setAiState('idle')
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  async function fetchModels() {
    modelRequest.current?.abort()
    const controller = new AbortController()
    modelRequest.current = controller
    setModelsState('loading')
    setModelsError(null)
    resetConnectionTest()
    try {
      const response = await apiFetch('api/ai/planner/models', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: aiDraft.provider,
          apiBase: aiDraft.apiBase,
          ...(aiApiKey.trim() ? { apiKey: aiApiKey } : {}),
          ...(connectionMode === 'existing' ? { reuseModelId: sourceModelId } : {}),
        }),
        signal: controller.signal,
      })
      const value = (await response.json()) as { models?: string[]; error?: string }
      if (modelRequest.current !== controller) return
      if (!response.ok) throw new Error(value.error ?? '利用可能なモデルを取得できません')
      const models = value.models ?? []
      if (models.length === 0) throw new Error('利用可能なモデルが見つかりませんでした')
      setAvailableModels(models)
      setAiDraft((current) => {
        const modelId = models.includes(current.modelId) ? current.modelId : models[0]!
        return { ...current, modelId, name: current.name || modelId }
      })
      setModelsState('loaded')
    } catch (e: unknown) {
      if (controller.signal.aborted) return
      setAvailableModels([])
      setModelsState('idle')
      setModelsError(e instanceof Error ? e.message : String(e))
    } finally {
      if (modelRequest.current === controller) modelRequest.current = null
    }
  }

  async function testAiPlanner() {
    testRequest.current?.abort()
    const controller = new AbortController()
    testRequest.current = controller
    setAiState('testing')
    setError(null)
    try {
      const response = await apiFetch('api/ai/planner/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: aiDraft.provider,
          modelId: aiDraft.modelId,
          apiBase: aiDraft.apiBase,
          ...(aiApiKey.trim() ? { apiKey: aiApiKey } : {}),
          ...(connectionMode === 'existing' ? { reuseModelId: sourceModelId } : {}),
        }),
        signal: controller.signal,
      })
      const value = (await response.json()) as { error?: string }
      if (testRequest.current !== controller) return
      if (!response.ok) throw new Error(value.error ?? 'AIプランナーへ接続できません')
      setAiState('ok')
    } catch (e: unknown) {
      if (controller.signal.aborted) return
      setAiState('idle')
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (testRequest.current === controller) testRequest.current = null
    }
  }

  const providerConnections = (() => {
    const groups = new Map<string, RegisteredAiModel>()
    for (const model of aiRegistry?.models ?? []) {
      const key = `${model.provider}\0${model.apiBase}`
      if (!groups.has(key)) groups.set(key, model)
    }
    return [...groups.values()]
  })()

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(20,30,38,.35)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 10,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 620,
          maxWidth: 'calc(100vw - 32px)',
          maxHeight: '82vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          background: '#fff',
          borderRadius: 12,
          boxShadow: '0 12px 40px rgba(0,0,0,.22)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            padding: '18px 22px 12px',
          }}
        >
          <h2 style={{ fontSize: 16, margin: 0 }}>設定</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <div
          role="tablist"
          aria-label="設定カテゴリ"
          style={{
          display: 'flex',
          gap: 4,
          padding: '0 22px',
          borderBottom: '1px solid #e0e5e8',
          overflowX: 'auto',
          }}
        >
          {SETTINGS_TABS.map((item) => {
          const active = item.id === tab
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setTab(item.id)
                setError(null)
              }}
              style={{
                flex: '0 0 auto',
                marginBottom: -1,
                padding: '9px 14px',
                border: 'none',
                borderBottom: `2px solid ${active ? PALETTE.image.main : 'transparent'}`,
                background: 'transparent',
                color: active ? PALETTE.image.text : '#64727b',
                fontSize: 12,
                fontWeight: active ? 700 : 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              {item.label}
            </button>
          )
          })}
        </div>

        <div style={{ overflowY: 'auto', padding: '0 22px 22px' }}>
          {tab === 'general' ? (
          <>
            <label style={LABEL}>ローカル保存先</label>
            <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 8px' }}>
              グラフ（PROV-JSONLD）と画像を置くフォルダ。Dropbox / Google Drive
              の同期フォルダを指定すれば、デバイス間で共有できる。
            </p>
            {workspace ? (
              <>
                <div
                  style={{
                    display: 'flex',
                    gap: 10,
                    alignItems: 'center',
                    border: '1px solid #e0e5e8',
                    borderRadius: 8,
                    padding: '10px 12px',
                  }}
                >
                  <code style={{ flex: 1, fontSize: 12, wordBreak: 'break-all' }}>
                    {workspace.current}
                  </code>
                  <button type="button" onClick={() => void pickFolder()} style={INPUT_BUTTON}>
                    変更…
                  </button>
                  {workspace.custom ? (
                    <button type="button" onClick={() => void resetFolder()} style={INPUT_BUTTON}>
                      既定へ戻す
                    </button>
                  ) : null}
                </div>
                <p style={{ fontSize: 11.5, color: '#a8513f', margin: '8px 0 0' }}>
                  既存の会話は自動では移りません。引き継ぐなら、旧フォルダの中身を手で移してください。
                </p>
              </>
            ) : (
              <p style={{ fontSize: 12, color: '#7b8892' }}>
                保存先を選べるのはデスクトップ版だけです。ブラウザでの開発中は{' '}
                <code>data/run</code> に置かれます。
              </p>
            )}

            <label style={LABEL}>画素を作る操作を使わない</label>
            <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 8px' }}>
              入力に無かった画素を作る操作（生成・生成編集・
              <strong>選択範囲の消去</strong>）を、計画の段階で断ります。
              回転・切り抜き・リサイズ・明るさ・コントラスト・ロゴタイプ・背景透明化は使えます。
              <br />
              消去（LaMa）も断るのは、<strong>消した跡を周囲から描いている</strong>ためです。
              乱数を使わないので再現はしますが、画素は作られています。
              <br />
              <strong>この設定自体は来歴に書きません。</strong>
              残すのは実際に実行されたものだけで、系譜の「画素の由来」を見れば、
              画素を作る手が 1 本も無いことは確定的に言えます。
            </p>
            <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
              <input
                type="checkbox"
                checked={forbidSynthesis}
                onChange={(e) => {
                  const next = e.target.checked
                  setForbidSynthesis(next)
                  void apiFetch('api/policy', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ forbidSynthesis: next }),
                  }).catch(() => setForbidSynthesis(!next))
                }}
              />
              画素を作る操作を断る
            </label>

            <label style={LABEL}>あなたの identity</label>
            <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 8px' }}>
              PROV 来歴の author として使われます（`prov:wasAssociatedWith` の人間
              Agent）。<strong>自己申告のみで、検証はしません。</strong>
            </p>
            <input
              value={identity.name}
              onChange={(e) => setIdentity({ ...identity, name: e.target.value })}
              placeholder="表示名"
              style={{ ...INPUT, marginBottom: 8 }}
            />
            <input
              value={identity.email}
              onChange={(e) => setIdentity({ ...identity, email: e.target.value })}
              placeholder="メール"
              style={INPUT}
            />
            <button
              type="button"
              onClick={() => void saveIdentity()}
              style={{
                marginTop: 10,
                padding: '8px 16px',
                border: 'none',
                borderRadius: 8,
                background: PALETTE.image.main,
                color: '#fff',
                fontSize: 13,
                cursor: 'pointer',
              }}
            >
              {saved ? '保存しました' : 'identity を保存'}
            </button>
          </>
          ) : null}

          {tab === 'ai' ? (
            <>
              <label style={LABEL}>指示のAI解釈（任意）</label>
              <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 8px' }}>
                有効にすると、外部またはローカルのLLMが指示を解釈します。使うツールを選び、
                会話の文脈から描く文字列を補い、画像モデル向けのプロンプトへ書き直します。
                解釈の結果は来歴に残ります。未設定・接続失敗時も、規則ベースで画像編集を続けられます。
              </p>
              {aiRegistry ? (
                <>
                  {aiRegistry.keyStorage === 'memory' ? (
                    <p style={{ fontSize: 12, color: '#b3541e', margin: '0 0 8px' }}>
                      APIキーはこのプロセスのメモリにだけ置かれます。サーバを再起動すると消えるので、
                      入れ直してください（デスクトップ版はKeychainへ保存します）。
                    </p>
                  ) : null}
                  <div
                    style={{
                      border: '1px solid #e0e5e8',
                      borderRadius: 8,
                      padding: '12px',
                    }}
                  >
                    <label
                      style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}
                    >
                      <input
                        type="checkbox"
                        checked={plannerDraft.enabled}
                        onChange={(e) => {
                          setPlannerDraft({ ...plannerDraft, enabled: e.target.checked })
                          setAiState('idle')
                        }}
                      />
                      AIに指示の解釈を任せる
                    </label>

                    <label style={FIELD_LABEL}>解釈に使うモデル</label>
                    <select
                      value={plannerDraft.selectedModelId}
                      onChange={(e) => {
                        setPlannerDraft({ ...plannerDraft, selectedModelId: e.target.value })
                        setAiState('idle')
                      }}
                      disabled={aiRegistry.models.length === 0}
                      style={INPUT}
                    >
                      <option value="">モデルを選択</option>
                      {aiRegistry.models.map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.name}（{model.modelId}）
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={() => void savePlannerSelection()}
                      disabled={
                        aiState === 'saving' ||
                        (plannerDraft.enabled && !plannerDraft.selectedModelId)
                      }
                      style={{ ...INPUT_BUTTON, marginTop: 10 }}
                    >
                      {aiState === 'saving'
                        ? '保存中…'
                        : aiState === 'saved'
                          ? '保存しました'
                          : '解釈の設定を保存'}
                    </button>
                    {plannerDraft.enabled !== aiRegistry.enabled ||
                    plannerDraft.selectedModelId !== aiRegistry.selectedModelId ? (
                      // チェックを入れただけでは効かない。保存を押すまで解釈は切り替わらない
                      <span style={{ marginLeft: 9, fontSize: 12, color: '#b3541e' }}>
                        未保存の変更があります
                      </span>
                    ) : null}
                  </div>

                  <div style={{ marginTop: 16 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        marginBottom: 8,
                      }}
                    >
                      <strong style={{ fontSize: 12, color: '#3f4a52' }}>
                        登録済みモデル
                      </strong>
                      <button
                        type="button"
                        onClick={() => {
                          setShowAddModel((visible) => !visible)
                          setDeleteConfirm(null)
                          setEditingModelId('')
                          if (!showAddModel) {
                            const first = providerConnections[0]
                            if (first) useExistingConnection(first.id)
                            else useNewConnection()
                          }
                        }}
                        style={INPUT_BUTTON}
                      >
                        {showAddModel ? '閉じる' : '＋ モデルを追加'}
                      </button>
                    </div>

                    {aiRegistry.models.length === 0 ? (
                      <p style={{ fontSize: 12, color: '#7b8892', margin: 0 }}>
                        登録済みモデルはありません。LLMなしでも規則ベースの画像編集は使えます。
                      </p>
                    ) : (
                      <div style={{ display: 'grid', gap: 8 }}>
                        {aiRegistry.models.map((model) => (
                          <div
                            key={model.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'space-between',
                              gap: 10,
                              border: '1px solid #e0e5e8',
                              borderRadius: 8,
                              padding: '9px 11px',
                            }}
                          >
                            <div style={{ minWidth: 0 }}>
                              <div style={{ fontSize: 13, fontWeight: 600 }}>
                                {model.name}
                                {model.id === aiRegistry.selectedModelId ? (
                                  <span
                                    style={{
                                      marginLeft: 7,
                                      color: aiRegistry.enabled ? PALETTE.image.main : '#8a959b',
                                    }}
                                  >
                                    {aiRegistry.enabled ? '使用中' : '選択中（解釈は無効）'}
                                  </span>
                                ) : null}
                                {model.hasApiKey ? null : (
                                  // キーはmemory保存だとサーバ再起動で消える。気づけないと401で初めて分かる
                                  <span style={{ marginLeft: 7, color: '#b3541e' }}>
                                    APIキー未設定
                                  </span>
                                )}
                              </div>
                              <div
                                style={{
                                  marginTop: 2,
                                  fontSize: 11.5,
                                  color: '#68767e',
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                }}
                              >
                                {AI_PROVIDERS.find((provider) => provider.id === model.provider)
                                  ?.name ?? model.provider}{' '}
                                / {model.modelId}
                              </div>
                            </div>
                            {deleteConfirm === model.id ? (
                              <div style={{ display: 'flex', gap: 5 }}>
                                <button
                                  type="button"
                                  onClick={() => void deleteAiModel(model.id)}
                                  disabled={aiState === 'deleting'}
                                  style={{ ...INPUT_BUTTON, color: '#a8513f' }}
                                >
                                  削除する
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteConfirm(null)}
                                  style={INPUT_BUTTON}
                                >
                                  戻る
                                </button>
                              </div>
                            ) : (
                              <div style={{ display: 'flex', gap: 5 }}>
                                <button
                                  type="button"
                                  onClick={() => editExistingModel(model.id)}
                                  style={INPUT_BUTTON}
                                >
                                  編集
                                </button>
                                <button
                                  type="button"
                                  onClick={() => setDeleteConfirm(model.id)}
                                  style={INPUT_BUTTON}
                                >
                                  削除
                                </button>
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {showAddModel ? (
                    <div
                      style={{
                        marginTop: 12,
                        border: `1px solid ${PALETTE.image.main}`,
                        borderRadius: 8,
                        padding: 12,
                        background: PALETTE.image.bg,
                      }}
                    >
                      <strong style={{ fontSize: 12, color: '#3f4a52' }}>
                        {editingModelId ? 'モデルを編集' : 'モデルを追加'}
                      </strong>
                      {editingModelId ? (
                        <p style={{ fontSize: 11.5, color: '#5c6b73', margin: '6px 0 0' }}>
                          APIキーは伏せたままです。空のまま保存すれば今の鍵を使い続けます。
                        </p>
                      ) : null}
                      {!editingModelId && providerConnections.length > 0 ? (
                        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                          <button
                            type="button"
                            onClick={() =>
                              useExistingConnection(sourceModelId || providerConnections[0]!.id)
                            }
                            style={MODE_BUTTON(connectionMode === 'existing')}
                          >
                            既存プロバイダーを使う
                          </button>
                          <button
                            type="button"
                            onClick={useNewConnection}
                            style={MODE_BUTTON(connectionMode === 'new')}
                          >
                            新しいプロバイダー
                          </button>
                        </div>
                      ) : null}

                      {!editingModelId &&
                      connectionMode === 'existing' &&
                      providerConnections.length > 0 ? (
                        <>
                          <label style={FIELD_LABEL}>既存プロバイダー</label>
                          <select
                            value={sourceModelId}
                            onChange={(e) => useExistingConnection(e.target.value)}
                            style={INPUT}
                          >
                            {providerConnections.map((model) => (
                              <option key={model.id} value={model.id}>
                                {AI_PROVIDERS.find(
                                  (provider) => provider.id === model.provider,
                                )?.name ?? model.provider}{' '}
                                — {model.apiBase}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : (
                        <>
                          <label style={FIELD_LABEL}>プロバイダー</label>
                          <select
                            value={aiDraft.provider}
                            onChange={(e) => {
                              const provider = e.target.value as AiProvider
                              const preset = AI_PROVIDERS.find((item) => item.id === provider)
                              setAiDraft({
                                ...aiDraft,
                                provider,
                                apiBase: preset?.defaultApiBase ?? '',
                                modelId: '',
                                name: '',
                              })
                              setAiApiKey('')
                              resetModelDiscovery()
                            }}
                            style={INPUT}
                          >
                            {AI_PROVIDERS.map((provider) => (
                              <option key={provider.id} value={provider.id}>
                                {provider.name}
                              </option>
                            ))}
                          </select>

                          <label style={FIELD_LABEL}>
                            API Base URL
                            {aiDraft.provider === 'openai-compatible' ? (
                              <span style={{ color: '#b5483e' }}> *</span>
                            ) : null}
                          </label>
                          <input
                            type="url"
                            value={aiDraft.apiBase}
                            onChange={(e) => {
                              setAiDraft({
                                ...aiDraft,
                                apiBase: e.target.value,
                                modelId: '',
                                name: '',
                              })
                              resetModelDiscovery()
                            }}
                            placeholder={
                              AI_PROVIDERS.find(
                                (provider) => provider.id === aiDraft.provider,
                              )?.defaultApiBase
                            }
                            style={INPUT}
                          />

                          <label style={FIELD_LABEL}>APIキー</label>
                          <input
                            type="password"
                            value={aiApiKey}
                            onChange={(e) => {
                              setAiApiKey(e.target.value)
                              resetModelDiscovery()
                            }}
                            placeholder={
                              aiDraft.provider === 'openai-compatible'
                                ? 'Ollamaなど認証不要の場合は空欄'
                                : 'APIキーを入力'
                            }
                            autoComplete="new-password"
                            style={INPUT}
                          />
                        </>
                      )}

                      <p style={{ fontSize: 11.5, color: '#5c6b73', margin: '6px 0 10px' }}>
                        {aiRegistry.keyStorage === 'keychain'
                          ? 'APIキーはmacOS Keychainへ保存し、設定ファイルには書きません。'
                          : 'この環境ではAPIキーをメモリだけに保持し、アプリ終了時に消去します。'}
                      </p>
                      <button
                        type="button"
                        onClick={() => void fetchModels()}
                        disabled={
                          modelsState === 'loading' ||
                          (connectionMode === 'new' &&
                            aiDraft.provider !== 'openai-compatible' &&
                            !aiApiKey.trim())
                        }
                        style={{ ...INPUT_BUTTON, width: '100%', padding: '8px 12px' }}
                      >
                        {modelsState === 'loading' ? '取得中…' : '利用可能なモデルを取得'}
                      </button>
                      {modelsError ? (
                        <p style={{ fontSize: 12, color: '#a8513f', margin: '8px 0 0' }}>
                          {modelsError}
                        </p>
                      ) : null}

                      {availableModels.length > 0 ? (
                        <>
                          <label style={FIELD_LABEL}>モデル</label>
                          <select
                            value={aiDraft.modelId}
                            onChange={(e) => {
                              setAiDraft({
                                ...aiDraft,
                                modelId: e.target.value,
                                name: e.target.value,
                              })
                              resetConnectionTest()
                            }}
                            style={INPUT}
                          >
                            {availableModels.map((model) => (
                              <option key={model} value={model}>
                                {model}
                              </option>
                            ))}
                          </select>
                        </>
                      ) : null}

                      <label style={FIELD_LABEL}>一覧にないモデルID（任意）</label>
                      <input
                        value={aiDraft.modelId}
                        onChange={(e) => {
                          setAiDraft({ ...aiDraft, modelId: e.target.value })
                          resetConnectionTest()
                        }}
                        placeholder="例: qwen2.5:3b"
                        style={INPUT}
                      />
                      <label style={FIELD_LABEL}>表示名</label>
                      <input
                        value={aiDraft.name}
                        onChange={(e) => setAiDraft({ ...aiDraft, name: e.target.value })}
                        placeholder={aiDraft.modelId || '設定画面で表示する名前'}
                        style={INPUT}
                      />

                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}
                      >
                        <button
                          type="button"
                          onClick={() => void addAiModel()}
                          disabled={!aiDraft.modelId.trim() || aiState === 'saving'}
                          style={INPUT_BUTTON}
                        >
                          {aiState === 'saving'
                            ? '保存中…'
                            : editingModelId
                              ? '変更を保存'
                              : 'モデルを登録'}
                        </button>
                        <button
                          type="button"
                          onClick={() => void testAiPlanner()}
                          disabled={!aiDraft.modelId.trim() || aiState === 'testing'}
                          style={INPUT_BUTTON}
                        >
                          {aiState === 'testing' ? '接続中…' : '接続テスト'}
                        </button>
                        {aiState === 'ok' ? (
                          <span style={{ fontSize: 12, color: '#387450' }}>
                            接続できました。
                          </span>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </>
              ) : (
                <p style={{ fontSize: 12, color: '#7b8892' }}>設定を読み込んでいます…</p>
              )}
            </>
          ) : null}

          {tab === 'about' ? (
          <>
            <label style={LABEL}>アプリ情報</label>
            <div
              style={{
                border: '1px solid #e0e5e8',
                borderRadius: 8,
                padding: '10px 12px',
                fontSize: 13,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ color: '#5c6b73' }}>アプリ名</span>
                <span>PROVision</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
                <span style={{ color: '#5c6b73' }}>バージョン</span>
                <code style={{ fontFamily: 'ui-monospace, monospace' }}>{version || '—'}</code>
              </div>
            </div>

            <label style={LABEL}>更新</label>
            {!isTauri() ? (
              <p style={{ fontSize: 12, color: '#7b8892', margin: 0 }}>
                更新の確認はデスクトップ版でのみ利用できます。
              </p>
            ) : update ? (
              <div
                style={{
                  border: `1px solid ${PALETTE.activity.main}`,
                  background: PALETTE.activity.bg,
                  borderRadius: 8,
                  padding: '10px 12px',
                }}
              >
                <p style={{ fontSize: 13, margin: '0 0 4px', color: PALETTE.activity.text }}>
                  新しいバージョン <strong>{update.version}</strong> があります（いまは{' '}
                  {update.currentVersion}）。
                </p>
                <p style={{ fontSize: 11.5, color: '#5c6b73', margin: '0 0 8px' }}>
                  当てるには再起動が要ります。生成の途中でないことを確かめてください。
                </p>
                <button
                  type="button"
                  onClick={() => void runInstall()}
                  disabled={updateState === 'installing'}
                  style={{
                    padding: '8px 16px',
                    border: 'none',
                    borderRadius: 8,
                    background: PALETTE.activity.main,
                    color: '#fff',
                    fontSize: 13,
                    cursor: updateState === 'installing' ? 'default' : 'pointer',
                  }}
                >
                  {updateState === 'installing'
                    ? `更新中… ${progress}%`
                    : '更新して再起動'}
                </button>
              </div>
            ) : (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <button
                  type="button"
                  onClick={() => void runCheck()}
                  disabled={updateState === 'checking'}
                  style={INPUT_BUTTON}
                >
                  {updateState === 'checking' ? '確認中…' : '更新を確認'}
                </button>
                {updateState === 'none' ? (
                  <span style={{ fontSize: 12, color: '#5c6b73' }}>最新です。</span>
                ) : null}
              </div>
            )}
            </>
          ) : null}

          {error ? (
            <p style={{ fontSize: 12, color: '#a8513f', marginTop: 12 }}>{error}</p>
          ) : null}
        </div>
      </div>
    </div>
  )
}

const INPUT_BUTTON: React.CSSProperties = {
  border: '1px solid #d8dfe3',
  borderRadius: 7,
  background: '#fff',
  padding: '6px 10px',
  fontSize: 12,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}
