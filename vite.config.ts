import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // グラフも画像もローカルのサーバから受け取る。vite の publicDir に依存しないので、
  // Tauri の WebView から同じコードがそのまま動く
  publicDir: false,
  server: {
    proxy: { '/api': 'http://127.0.0.1:8788' },
  },
})
