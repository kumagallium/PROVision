/**
 * 実際の LLM が指示をどのツールへ振り分けるかを、絵を作らずに確かめる。
 *
 * 画像を 1 枚作ると数分かかるので、振り分けの誤りを画面越しに見つけていると
 * 直すより探す時間の方が長くなる。ここは planner だけを叩くので数秒で回る。
 *
 *   PROVISION_USE_KEYCHAIN=1 pnpm tsx scripts/check-routing.ts
 *   PROVISION_USE_KEYCHAIN=1 pnpm tsx scripts/check-routing.ts "余白を整えて"
 *
 * 引数を渡すとその指示だけを試す。渡さなければ IMAGE_TOOLS の examples を全部流す。
 */
import { planImageOperation } from '../src/ai/planner.js'
import { plannerCredentials } from '../src/ai/config.js'
import { IMAGE_TOOLS } from '../src/ai/tools.js'

const dataDir = process.env.PROVISION_DATA_DIR ?? 'data/run'
const planner = await plannerCredentials(dataDir)

if (!planner.enabled || !planner.modelId.trim()) {
  console.error('LLM が無効です。設定の AI タブで解釈を有効にしてください')
  process.exit(1)
}
console.log(`LLM: ${planner.provider} / ${planner.modelId}\n`)

/** 会話の文脈。製品名は根の指示にしかないので、そこから拾えるかを見る */
const lineage = [
  'asterismは、これまで研究室や組織の中に埋もれていたデータという星を、自分たちの理解というオントロジーという星座を描くことで、AIがデータを参照できるようになる世界観のプロダクトのロゴ',
]

// --parent=image.wordmark のように、親を作ったツールを指定できる
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--parent='))
const parentTool = process.argv
  .slice(2)
  .find((a) => a.startsWith('--parent='))
  ?.slice('--parent='.length)

const cases = argv.length
  ? argv.map((intent) => ({ intent, expect: undefined as string | undefined, hasSourceImage: true, hasEditRegion: false }))
  : IMAGE_TOOLS.flatMap((tool) =>
      (tool.examples ?? []).map((example) => ({
        intent: example.intent,
        expect: tool.name as string,
        hasSourceImage: example.hasSourceImage ?? true,
        hasEditRegion: example.hasEditRegion ?? false,
      })),
    )

let mismatched = 0
for (const c of cases) {
  const planned = await planImageOperation({
    intent: c.intent,
    context: {
      hasSourceImage: c.hasSourceImage,
      hasEditRegion: c.hasEditRegion,
      ...(parentTool ? { parentTool: parentTool as never } : {}),
    },
    lineage,
    planner,
  })
  const actual = planned.plan.tool
  const ok = !c.expect || actual === c.expect
  if (!ok) mismatched += 1
  const mark = !c.expect ? '·' : ok ? '✓' : '✗'
  const args = JSON.stringify(planned.plan.arguments)
  console.log(`${mark} 「${c.intent}」`)
  console.log(
    `    ${actual} ${args} [${planned.mode}]` +
      (c.expect && !ok ? `  期待: ${c.expect}` : '') +
      (planned.warning ? `\n    ⚠ ${planned.warning}` : ''),
  )
}

if (cases.some((c) => c.expect)) {
  console.log(`\n食い違い: ${mismatched} / ${cases.length}`)
  // 判断の揺れは LLM の性質なので、失敗させず数だけ出す。
  // 揺れが許せない指示は、規則ベースへ書き足して確定させる
}
