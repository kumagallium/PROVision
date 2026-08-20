/**
 * サーバから画像を出す `<img>`。
 *
 * Tauri の WebView では `<img src="http://127.0.0.1:...">` も mixed content で
 * 落ちるので、plugin-http で取ってきて blob: に変えてから渡す。
 * ブラウザではそのまま素の URL を使う（余計な往復を増やさない）。
 */
import { useEffect, useState } from 'react'
import { apiFetch, isTauri } from './api-base.js'

export function ProvImage({
  path,
  alt,
  style,
}: {
  /** `/api/images/xxx.png` のような、サーバ上の位置 */
  path: string | undefined
  alt?: string
  style?: React.CSSProperties
}) {
  const [src, setSrc] = useState<string | undefined>(
    path && !isTauri() ? path : undefined,
  )

  useEffect(() => {
    if (!path) {
      setSrc(undefined)
      return
    }
    if (!isTauri()) {
      setSrc(path)
      return
    }
    let url: string | undefined
    let cancelled = false
    void apiFetch(path)
      .then((r) => r.blob())
      .then((blob) => {
        if (cancelled) return
        url = URL.createObjectURL(blob)
        setSrc(url)
      })
      .catch(() => setSrc(undefined))
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])

  if (!src) return <div style={{ ...style, background: '#eef1f2' }} />
  return <img src={src} alt={alt ?? ''} style={style} />
}
