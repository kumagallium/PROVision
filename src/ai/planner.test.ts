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

  it('文字列が明示された追加だけをフォント描画へ回す', () => {
    const ctx = { hasSourceImage: true, hasEditRegion: false }
    // 文字列が分かっているときだけ確定的に置く
    expect(ruleBasedPlan('「asterism」というロゴタイプを付けて', ctx)).toMatchObject({
      tool: 'image.wordmark',
      arguments: { text: 'asterism' },
    })
    // 文字列が分からない追加は、従来どおり生成側へ（LLMが補える）
    expect(ruleBasedPlan('ロゴタイプを追加してください', ctx).tool).toBe('image.edit')
    // 引用符があっても、追加でなければ巻き込まない
    expect(ruleBasedPlan('「asterism」の文字を消して', ctx).tool).toBe('image.edit')
    expect(ruleBasedPlan('「青」を基調に塗り直して', ctx).tool).toBe('image.edit')
    // 削除の明示指示は範囲指定があればLaMaのまま
    expect(
      ruleBasedPlan('「asterism」を消して', { hasSourceImage: true, hasEditRegion: true }).tool,
    ).toBe('image.erase')
  })

  it('文字列のないワードマーク計画を拒否する', () => {
    expect(() =>
      validateImagePlan(
        { tool: 'image.wordmark', arguments: {}, reason: 'add' },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('文字列')
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

  it('書き直しプロンプトを検証して採用する', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"tool":"image.edit","arguments":{"text":"asterism"},"reason":"add wordmark","prompt":"Add the wordmark \\"asterism\\" below the\\n constellation symbol."}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const planned = await planImageOperation({
      intent: 'ロゴタイプを追加してください',
      context: { hasSourceImage: true, hasEditRegion: false },
      lineage: ['asterismは、埋もれていたデータという星を結ぶプロダクトのロゴ'],
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'qwen2.5:3b',
        apiBase: 'http://127.0.0.1:11434/v1',
        apiKey: '',
      },
    })
    expect(planned.mode).toBe('llm')
    expect(planned.plan.arguments.text).toBe('asterism')
    // 改行は1つの空白へ正規化される
    expect(planned.plan.prompt).toBe('Add the wordmark "asterism" below the constellation symbol.')
  })

  it('推定したtextが書き直しから落ちた計画を拒否して規則ベースへ戻す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content:
                    '{"tool":"image.edit","arguments":{"text":"asterism"},"reason":"add","prompt":"Add a wordmark below the symbol."}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const planned = await planImageOperation({
      intent: 'ロゴタイプを追加してください',
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
    expect(planned.warning).toContain('text')
  })

  it('推論で本文が尽きた応答を、切れたと名指しして規則ベースへ戻す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [{ finish_reason: 'length', message: { content: '', reasoning_content: 'We need to…' } }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const planned = await planImageOperation({
      intent: 'ロゴタイプを追加してください',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'gpt-oss-120b',
        apiBase: 'https://api.ai.sakura.ad.jp/v1',
        apiKey: 'k',
      },
    })
    expect(planned.mode).toBe('rules')
    expect(planned.warning).toContain('上限で切れました')
  })

  it('思考側にJSONを入れて返すモデルからも計画を取り出す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: 'stop',
                message: {
                  content: '',
                  reasoning_content: 'thinking… {"tool":"image.edit","arguments":{},"reason":"tone"}',
                },
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    const planned = await planImageOperation({
      intent: 'もう少し落ち着いた感じにして',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'local',
        apiBase: 'http://127.0.0.1:11434/v1',
        apiKey: '',
      },
    })
    expect(planned.mode).toBe('llm')
    expect(planned.plan.tool).toBe('image.edit')
  })

  it('text引数を検証して受け入れる', () => {
    const plan = validateImagePlan(
      { tool: 'image.edit', arguments: { text: ' asterism ' }, reason: 'add wordmark' },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.arguments.text).toBe('asterism')
    // 文字を描けないツールでは拒否する
    expect(() =>
      validateImagePlan(
        { tool: 'image.rotate', arguments: { angle: 90, text: 'x' } },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('text')
    // 長すぎる文字列と制御文字を拒否する
    expect(() =>
      validateImagePlan(
        { tool: 'image.edit', arguments: { text: 'a'.repeat(41) } },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('40文字')
    expect(() =>
      validateImagePlan(
        { tool: 'image.edit', arguments: { text: 'a\u0000b' } },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('40文字')
  })

  it('文字を描けないツールの書き直しプロンプトを拒否する', () => {
    expect(() =>
      validateImagePlan(
        { tool: 'image.rotate', arguments: { angle: 90 }, prompt: 'Rotate it.' },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow('prompt')
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
