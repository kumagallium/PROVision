/**
 * 設定 — 保存先と identity。
 *
 * 保存先の既定は **Documents/PROVision**。Application Support に隠すと、
 * 利用者が中身（グラフの JSON-LD と画像）を見にいけない。この道具の成果物は
 * 書き出したファイルそのものなので、手の届く場所に置く。
 *
 * 保存先を変えても**中身は移さない**。黙って動かすと、どちらが本物か分からなくなる。
 */
import { useEffect, useState } from 'react'
import { apiFetch, isTauri } from './api-base.js'
import { PALETTE } from './palette.js'

interface WorkspaceInfo {
  current: string
  default: string
  custom: boolean
}

interface Identity {
  name: string
  email: string
}

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

export function SettingsDialog({
  onClose,
  onWorkspaceChanged,
}: {
  onClose: () => void
  /** 保存先が変わったら、サイドカーを入れ直してグラフを読み直してもらう */
  onWorkspaceChanged: () => void
}) {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null)
  const [identity, setIdentity] = useState<Identity>({ name: '', email: '' })
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void apiFetch('api/identity')
      .then((r) => r.json())
      .then((v: Identity) => setIdentity(v))
      .catch(() => undefined)

    if (!isTauri()) return
    void import('@tauri-apps/api/core')
      .then(({ invoke }) => invoke<WorkspaceInfo>('get_workspace_root'))
      .then(setWorkspace)
      .catch((e: unknown) => setError(String(e)))
  }, [])

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
          width: 560,
          maxHeight: '80vh',
          overflowY: 'auto',
          background: '#fff',
          borderRadius: 12,
          padding: '18px 22px 22px',
          boxShadow: '0 12px 40px rgba(0,0,0,.22)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <h2 style={{ fontSize: 16, margin: 0 }}>設定</h2>
          <button
            type="button"
            onClick={onClose}
            style={{ border: 'none', background: 'none', fontSize: 18, cursor: 'pointer' }}
          >
            ×
          </button>
        </div>

        <label style={LABEL}>ローカル保存先</label>
        <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 8px' }}>
          グラフ（PROV-JSONLD）と画像を置くフォルダ。Dropbox / Google Drive の同期フォルダを
          指定すれば、デバイス間で共有できる。
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

        <label style={LABEL}>あなたの identity</label>
        <p style={{ fontSize: 12, color: '#5c6b73', margin: '0 0 8px' }}>
          PROV 来歴の author として使われます（`prov:wasAssociatedWith` の人間 Agent）。
          <strong>自己申告のみで、検証はしません。</strong>
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

        {error ? (
          <p style={{ fontSize: 12, color: '#a8513f', marginTop: 12 }}>{error}</p>
        ) : null}
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
