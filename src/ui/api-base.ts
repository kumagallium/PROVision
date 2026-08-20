/**
 * 画面からローカルサーバを叩く口。
 *
 * ブラウザでの開発中は vite のプロキシがあるので相対パスでよい。
 * Tauri の WebView からは **素の fetch が使えない**——tauri://localhost から
 * http://127.0.0.1 への要求は mixed content として黙って落とされる（geo-logo の実測）。
 * そこだけ @tauri-apps/plugin-http に迂回する。
 */

export const SIDECAR_PORT = 8788

export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export function apiUrl(path: string): string {
  const clean = path.replace(/^\//, '')
  return isTauri() ? `http://127.0.0.1:${SIDECAR_PORT}/${clean}` : `/${clean}`
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = apiUrl(path)
  if (!isTauri()) return fetch(url, init)
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  return tauriFetch(url, init)
}

/**
 * サイドカーを起動して疎通するまで待つ。ブラウザでは何もしない
 * （`pnpm dev` がサーバごと上げているため）。
 */
export async function ensureSidecar(timeoutMs = 30_000): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')
  await invoke('start_sidecar', { port: SIDECAR_PORT })

  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const res = await apiFetch('api/graph')
      if (res.ok) return
    } catch {
      // まだ起きていない
    }
    if (Date.now() > deadline) throw new Error('サイドカーが応答しません')
    await new Promise((r) => setTimeout(r, 300))
  }
}
