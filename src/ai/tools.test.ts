import { describe, expect, it } from 'vitest'
import {
  ARGUMENT_LABELS,
  IMAGE_TOOLS,
  imageToolDefinition,
  toolCatalogForPrompt,
} from './tools.js'
import { ruleBasedPlan, validateImagePlan } from './planner.js'

describe('画像ツールの定義', () => {
  it('必須引数は必ず受け取れる引数でもある', () => {
    // 受け取れない引数を必須にすると、決して満たせない計画になる
    for (const tool of IMAGE_TOOLS) {
      for (const name of tool.requiredArguments ?? []) {
        expect(tool.accepts, `${tool.name}のaccepts`).toContain(name)
      }
    }
  })

  it('すべての引数に画面用の名前がある', () => {
    for (const tool of IMAGE_TOOLS) {
      for (const name of tool.accepts) {
        expect(ARGUMENT_LABELS[name], `${name}のラベル`).toBeTruthy()
      }
    }
  })

  it('LLMへ渡す一覧に、すべてのツールと注意書きが載る', () => {
    const catalog = toolCatalogForPrompt()
    for (const tool of IMAGE_TOOLS) {
      expect(catalog).toContain(tool.name)
    }
    // 誤分類の歯止めが説明から抜けない
    expect(catalog).toContain('Do not choose it when')
  })

  it('宣言した前提が検証と食い違わない', () => {
    for (const tool of IMAGE_TOOLS) {
      const spec = imageToolDefinition(tool.name)
      const context = {
        hasSourceImage: spec.requiresSourceImage !== 'forbidden',
        hasEditRegion: true,
      }
      // 必須引数を満たした最小の計画は、必ず通る
      const args: Record<string, unknown> = {}
      for (const name of spec.requiredArguments ?? []) {
        args[name] = name === 'angle' ? 90 : name === 'text' ? 'asterism' : 24
      }
      if (tool.name === 'image.resize') args.width = 600
      const plan = validateImagePlan({ tool: tool.name, arguments: args }, context)
      expect(plan.tool).toBe(tool.name)
    }
  })

  it('編集元画像の要否が宣言どおりに効く', () => {
    for (const tool of IMAGE_TOOLS) {
      const spec = imageToolDefinition(tool.name)
      if (spec.requiresSourceImage !== true) continue
      expect(() =>
        validateImagePlan(
          { tool: tool.name, arguments: {} },
          { hasSourceImage: false, hasEditRegion: false },
        ),
        `${tool.name}は編集元画像なしで通ってはいけない`,
      ).toThrow()
    }
  })
})

describe('例文の振り分け（LLMなしの規則ベース）', () => {
  // 定義に書いた examples を、そのまま回帰テストとして流す。
  // 誤分類が見つかったら examples へ 1 行足せば、以後は構造が守る
  const cases = IMAGE_TOOLS.flatMap((tool) =>
    (tool.examples ?? []).map((example) => ({ tool: tool.name, ...example })),
  )

  for (const c of cases) {
    const context = {
      hasSourceImage: c.hasSourceImage ?? true,
      hasEditRegion: c.hasEditRegion ?? false,
    }
    it(`「${c.intent}」`, () => {
      const plan = ruleBasedPlan(c.intent, context)
      // 規則で確定できない指示は image.edit / image.generate へ預け、LLM が判断する。
      // そこへ落ちること自体は誤りではないので、別ツールへ誤爆しないことだけ見る
      const fallback = context.hasSourceImage ? 'image.edit' : 'image.generate'
      expect([c.tool, fallback]).toContain(plan.tool)
    })
  }
})
