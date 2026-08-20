/**
 * Hono サーバを 1 ファイルにまとめ、サイドカーとして同梱できるようにする。
 *
 * banner の中身は geo-logo / Graphium が実際に踏んだ不具合の対策なので、
 * そのまま持ってきている。
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/server/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'src-tauri/sidecar/server.mjs',
  external: ['node:*'],
  banner: {
    js: [
      // ESM バンドルには require が無い。CJS 由来の依存が同期 require を使う
      "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      // ESM では __dirname / __filename がスコープに無い。CJS 由来の依存が
      // トップレベルで参照すると、読み込み時に ReferenceError で無音終了する
      "import { fileURLToPath as __toPath } from 'node:url'; import { dirname as __dir } from 'node:path'; const __filename = __toPath(import.meta.url); const __dirname = __dir(__filename);",
      // 起動直後に 1 行 stderr へ出す。「spawn は成功したがログが 0 行」のとき、
      // pipe が生きているかの切り分けに要る
      "process.stderr.write('[sidecar-probe] boot\\n');",
      // top-level import が同期的に throw したときの無音終了を防ぐ
      "process.on('uncaughtException', (e) => { process.stderr.write('[uncaught] ' + (e && e.stack || e) + '\\n'); process.exit(99); });",
      "process.on('unhandledRejection', (e) => { process.stderr.write('[unhandled] ' + (e && e.stack || e) + '\\n'); });",
    ].join('\n'),
  },
})
console.log('src-tauri/sidecar/server.mjs を書いた')
