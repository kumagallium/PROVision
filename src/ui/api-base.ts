/**
 * 画面からローカルサーバを叩く口。
 *
 * ブラウザでの開発中は vite のプロキシがあるので相対パスでよい。
 * Tauri の WebView からは **素の fetch が使えない**——tauri://localhost から
 * http://127.0.0.1 への要求は mixed content として黙って落とされる（geo-logo の実測）。
 * そこだけ @tauri-apps/plugin-http に迂回する。
 */

/**
 * サイドカーの既定ポート。**ここが空いている保証は無い**——利用者の PC では
 * 別のアプリが同じポートを握っていることがある（実測: asterism-local が 8788 で
 * 画面 HTML を 200 で返し、それを JSON として読もうとして起動できなかった）。
 * 空いていなければ順に次を試す（D-024）
 */
export const SIDECAR_PORT = 8788

/** 既定が塞がっていたときに試す先。5 つ試して駄目なら諦めて理由を出す */
const PORT_CANDIDATES = [SIDECAR_PORT, 8789, 8790, 8791, 8792]

/** 実際に使えたポート。ensureSidecar が決めるまでは既定を指す */
let activePort = SIDECAR_PORT

export function isTauri(): boolean {
  if (typeof window === 'undefined') return false
  const internal = (
    window as typeof window & {
      __TAURI_INTERNALS__?: {
        invoke?: unknown
        metadata?: { currentWebview?: { label?: string } }
      }
    }
  ).__TAURI_INTERNALS__
  if (internal?.metadata?.currentWebview?.label?.startsWith('browser-preview-')) return false
  return typeof internal?.invoke === 'function'
}

export function apiUrl(path: string): string {
  const clean = path.replace(/^\//, '')
  return isTauri() ? `http://127.0.0.1:${activePort}/${clean}` : `/${clean}`
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = apiUrl(path)
  if (!isTauri()) return fetch(url, init)
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  return tauriFetch(url, init)
}

/**
 * `/api/health` の中身が PROVision のものか（D-024）。
 *
 * **200 が返ったことだけで自分のサーバだと決めない。** 同じポートを別のアプリが
 * 握っていると、そちらの画面 HTML が 200 で返る（実測）。印を見るまで信用しない
 */
export function isProvisionHealth(body: unknown): boolean {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as { app?: unknown }).app === 'provision'
  )
}

/**
 * そのポートに居るのが **PROVision のサーバか**を確かめる（D-024）。
 *
 * **200 が返ったことだけで自分のサーバだと決めない。** 別のアプリが同じポートを
 * 握っていると、そちらの画面 HTML が 200 で返る。`app` の印まで見る
 */
async function isProvisionAt(port: number): Promise<'own' | 'stranger' | 'silent'> {
  const { fetch: tauriFetch } = await import('@tauri-apps/plugin-http')
  let res: Response
  try {
    res = await tauriFetch(`http://127.0.0.1:${port}/api/health`)
  } catch {
    // 誰も応答しない＝空いているとみなす
    return 'silent'
  }
  if (!res.ok) return 'stranger'
  try {
    return isProvisionHealth(await res.json()) ? 'own' : 'stranger'
  } catch {
    // **JSON ですらない応答は他人**。ここを「空き」に倒すと、塞がったポートへ
    // 起こしにいって時間だけ溶かす（実測: 相手は画面 HTML を 200 で返していた）
    return 'stranger'
  }
}

/**
 * サイドカーを起動して疎通するまで待つ。ブラウザでは何もしない
 * （`pnpm dev` がサーバごと上げているため）。
 *
 * **ポートは決め打ちにしない。** 既に自分のサーバが居ればそれを使い、他人が居れば
 * 次のポートへ移る。どこにも置けなければ、**何が起きたかを言って**終わる（D-024）。
 */
export async function ensureSidecar(timeoutMs = 30_000): Promise<void> {
  if (!isTauri()) return
  const { invoke } = await import('@tauri-apps/api/core')

  const occupied: number[] = []
  for (const port of PORT_CANDIDATES) {
    const who = await isProvisionAt(port)
    if (who === 'own') {
      activePort = port
      return
    }
    if (who === 'stranger') {
      occupied.push(port)
      continue
    }

    // 空いていそうなので、ここで起こしてみる
    await invoke('start_sidecar', { port })
    const deadline = Date.now() + timeoutMs
    for (;;) {
      if ((await isProvisionAt(port)) === 'own') {
        activePort = port
        return
      }
      if (Date.now() > deadline) break
      await new Promise((r) => setTimeout(r, 300))
    }
    occupied.push(port)
  }

  throw new Error(
    `ローカルサーバを置けるポートがありません（${occupied.join(', ')} は別のアプリが使っています）。` +
      'そのアプリを止めてから開き直してください',
  )
}
