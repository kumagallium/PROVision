import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // data/ をそのまま配信する。グラフ（run/lineage.jsonld）と画像（run/images/*.png）を
  // 別サーバ無しで読むため。書き出したファイルが唯一の入力である、という設計に合わせる
  publicDir: 'data',
})
