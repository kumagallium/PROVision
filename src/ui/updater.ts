/**
 * 自動更新。デスクトップ版だけで動く。
 *
 * 配信先は `tauri.conf.json` の endpoints（1 番目が GitHub Pages の
 * `docs/updater/latest.json`、2 番目が Release の同名ファイル）。
 * **順に試されるので、先頭が古いと更新が出ない**——Pages 側を真実源にしてある。
 */
import pkg from '../../package.json'

export interface UpdateInfo {
  /** 配信されている新しい版 */
  version: string
  /** いま動いている版 */
  currentVersion: string
  notes?: string
}

/** check() が返す Update は install 時にも要るので、確認から適用まで持っておく */
let pending: { downloadAndInstall: (cb?: (e: unknown) => void) => Promise<void> } | null =
  null

export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

export async function appVersion(): Promise<string> {
  if (!isDesktop()) return pkg.version
  try {
    const { getVersion } = await import('@tauri-apps/api/app')
    return await getVersion()
  } catch {
    return pkg.version
  }
}

/**
 * 新しい版があるか見る。無ければ null。
 * ブラウザでは常に null（配布物が無いので確認しようがない）。
 */
export async function checkUpdate(): Promise<UpdateInfo | null> {
  if (!isDesktop()) return null
  const { check } = await import('@tauri-apps/plugin-updater')
  const update = await check()
  if (!update) {
    pending = null
    return null
  }
  pending = update as unknown as typeof pending
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    ...(update.body ? { notes: update.body } : {}),
  }
}

/**
 * 落として当てて、再起動する。
 * 再起動しないと当たらないので、ここまでを 1 つの操作にしておく。
 */
export async function installAndRelaunch(
  onProgress?: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  if (!pending) throw new Error('先に更新の確認をしてください')
  let downloaded = 0
  let total: number | undefined
  await pending.downloadAndInstall((event: unknown) => {
    const e = event as { event: string; data?: { contentLength?: number; chunkLength?: number } }
    if (e.event === 'Started') total = e.data?.contentLength
    if (e.event === 'Progress') {
      downloaded += e.data?.chunkLength ?? 0
      onProgress?.(downloaded, total)
    }
  })
  const { relaunch } = await import('@tauri-apps/plugin-process')
  await relaunch()
}
