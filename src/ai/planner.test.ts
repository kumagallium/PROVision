import { afterEach, describe, expect, it, vi } from 'vitest'
import { planImageOperation, ruleBasedPlan, validateImagePlan } from './planner.js'

afterEach(() => vi.unstubAllGlobals())

describe('画像ツールプランナー', () => {
  it('LLMなしでも明示的な操作を振り分ける', () => {
    expect(
      ruleBasedPlan('背景を透明にして', { hasSourceImage: true, hasEditRegion: false }).tool,
    ).toBe('background.remove')
    expect(
      ruleBasedPlan('90度回転して', { hasSourceImage: true, hasEditRegion: false }),
    ).toMatchObject({ tool: 'image.rotate', arguments: { angle: 90 } })
    expect(
      ruleBasedPlan('512x256にリサイズ', { hasSourceImage: true, hasEditRegion: false }),
    ).toMatchObject({ tool: 'image.resize', arguments: { width: 512, height: 256 } })
  })

  it('範囲指定された削除をLaMaへ振り分ける', () => {
    expect(
      ruleBasedPlan('この文字を消して', { hasSourceImage: true, hasEditRegion: true }).tool,
    ).toBe('image.erase')
  })

  it('LLM未設定なら一般編集も規則ベースで継続できる', async () => {
    const planned = await planImageOperation({
      intent: 'もっと青くして',
      context: { hasSourceImage: true, hasEditRegion: false },
    })
    expect(planned).toMatchObject({ mode: 'rules', plan: { tool: 'image.edit' } })
  })

  it('OpenAI互換の軽量LLMが返した許可済み計画を採用する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"tool":"image.crop-square","arguments":{},"reason":"square request"}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const planned = await planImageOperation({
      intent: 'Make this suitable for a square profile image.',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'qwen2.5:3b',
        apiBase: 'http://127.0.0.1:11434/v1',
        apiKey: '',
      },
    })
    expect(planned).toMatchObject({
      mode: 'llm',
      plannerProvider: 'openai-compatible',
      plannerModel: 'qwen2.5:3b',
      plan: { tool: 'image.crop-square' },
    })
  })

  it('LLMの不正な計画を実行せず規則ベースへ戻す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: '{"tool":"shell.exec","arguments":{}}' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const planned = await planImageOperation({
      intent: 'Make it warmer.',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'local',
        apiBase: 'http://localhost:11434/v1',
        apiKey: '',
      },
    })
    expect(planned.mode).toBe('rules')
    expect(planned.plan.tool).toBe('image.edit')
    expect(planned.warning).toContain('未対応')
  })

  it('存在しないツールと危険な引数を拒否する', () => {
    expect(() =>
      validateImagePlan(
        { tool: 'shell.exec', arguments: {} },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('未対応')
    expect(() =>
      validateImagePlan(
        { tool: 'image.resize', arguments: { width: 100000 } },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('width')
  })
})
