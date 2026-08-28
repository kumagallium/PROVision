import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // グラフも画像もローカルのサーバから受け取る。vite の publicDir に依存しないので、
  // Tauri の WebView から同じコードがそのまま動く
  publicDir: false,
  server: {
    /**
     * 開発中の宛先。**決め打ちにしない**（D-024 と同じ理由）——配布版の
     * PROVision を起動したまま開発すると 8788 は塞がっている。サーバ側を
     * `PROVISION_PORT` でずらしたとき、ここも同じ番号を向く必要がある
     */
    proxy: { '/api': `http://127.0.0.1:${process.env.PROVISION_PORT ?? 8788}` },
  },
})
