import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_REWRITTEN_PROMPT_LENGTH,
  MAX_VARIANTS,
  SynthesisForbiddenError,
  asksForMultipleCandidates,
  editScopeOf,
  needsTranslation,
  planImageOperation,
  proposeVariantPrompts,
  ruleBasedPlan,
  validateImagePlan,
} from './planner.js'
import { toolCatalogForPrompt } from './tools.js'

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

  it('ワードマークに書き直し文が付いてきても計画を捨てない', () => {
    // 実測: 弾いた結果フォールバックし、生成側が無関係な文字を描いた
    const plan = validateImagePlan(
      {
        tool: 'image.wordmark',
        arguments: { text: 'asterism' },
        reason: 'add',
        prompt: 'Add the wordmark "asterism" below the symbol.',
      },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.tool).toBe('image.wordmark')
    expect(plan.arguments.text).toBe('asterism')
    // 使い道がないので落ちる
    expect(plan.prompt).toBeUndefined()
  })

  it('既にある文字を整える依頼は確定描画で重ねない', () => {
    const ctx = { hasSourceImage: true, hasEditRegion: false }
    // 実測: これでワードマークが走り、asterism が二重になった
    expect(ruleBasedPlan('文字とロゴに統一感をもたせた形にしてください。', ctx).tool).toBe(
      'image.edit',
    )
    expect(ruleBasedPlan('「asterism」の文字を少し小さくして', ctx).tool).toBe('image.edit')
    expect(ruleBasedPlan('「asterism」のバランスを整えて', ctx).tool).toBe('image.edit')
    // 純粋な追加は従来どおり確定描画へ
    expect(ruleBasedPlan('「asterism」というロゴタイプを付けて', ctx).tool).toBe(
      'image.wordmark',
    )
  })

  it('作り直しでは、描く文字列を来歴から引き継ぐ', () => {
    // LLMは画像に何と書いてあるか見られない。textを落としても計画を捨てない
    const plan = validateImagePlan(
      { tool: 'image.wordmark', arguments: { padding: 8 }, reason: 'tighten the gap' },
      {
        hasSourceImage: true,
        hasEditRegion: false,
        parentTool: 'image.wordmark',
        parentText: 'asterism',
      },
    )
    expect(plan.arguments.text).toBe('asterism')
    expect(plan.arguments.padding).toBe(8)
  })

  it('親がワードマークでなければ引き継がない', () => {
    expect(() =>
      validateImagePlan(
        { tool: 'image.wordmark', arguments: { padding: 8 } },
        {
          hasSourceImage: true,
          hasEditRegion: false,
          parentTool: 'image.edit',
          parentText: 'asterism',
        },
      ),
    ).toThrow('描く文字列')
  })

  it('要素の間の余白は、外周のトリミングへ流さない', () => {
    const ctx = { hasSourceImage: true, hasEditRegion: false }
    // 実測: 「ロゴタイプの余白」がtrimへ落ち、外周だけ削られた
    expect(ruleBasedPlan('ロゴタイプの余白を詰めて', ctx).tool).toBe('image.edit')
    expect(ruleBasedPlan('ロゴとロゴタイプの間の余白を広げて', ctx).tool).toBe('image.edit')
    // 外周の余白は従来どおり確定させる
    expect(ruleBasedPlan('全体的な余白の調整をいい感じにして', ctx).tool).toBe('image.trim')
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

  it('訳し漏れを清書の失敗として扱う', () => {
    expect(needsTranslation('弓矢を無くして、色も1色にして')).toBe(true)
    expect(needsTranslation('Remove the bow and arrow. No bow, no arrow.')).toBe(false)
    // 描く文字列が日本語なら、それは訳し漏れではない
    expect(needsTranslation('Add the wordmark "星座" below the symbol.', '星座')).toBe(false)
  })

  it('清書が欠けたら、清書だけを頼み直して埋める', async () => {
    // 実測: 振り分けは image.edit で当たっていたのに prompt が無く、
    // 「弓矢を無くして、使う色も１色にした…」がそのまま画像モデルへ渡っていた
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json({
          choices: [
            { message: { content: '{"tool":"image.edit","arguments":{},"reason":"restyle"}' } },
          ],
        }),
      )
      .mockResolvedValueOnce(
        json({
          choices: [
            {
              message: {
                content:
                  '{"prompt":"Redraw the emblem as a flat vector illustration in a single blue. No bow, no arrow anywhere."}',
              },
            },
          ],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const planned = await planImageOperation({
      intent: '弓矢を無くして、使う色も１色にしたシンプル板が欲しい',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'gpt-oss-120b',
        apiBase: 'https://example.invalid/v1',
        apiKey: 'k',
      },
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(planned.plan.tool).toBe('image.edit')
    expect(planned.plan.prompt).toContain('No bow, no arrow')
    expect(planned.warning).toBeUndefined()
  })

  it('頼み直しにも失敗したら、計画は残して警告だけ出す', async () => {
    // 選ばれたツールは当たっている。計画ごと捨てると別のツールが動く（D-013）
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: '{"tool":"image.edit","arguments":{},"reason":"restyle"}',
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const planned = await planImageOperation({
      intent: '弓矢を無くして',
      context: { hasSourceImage: true, hasEditRegion: false },
      planner: {
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'gpt-oss-120b',
        apiBase: 'https://example.invalid/v1',
        apiKey: 'k',
      },
    })
    expect(planned.plan.tool).toBe('image.edit')
    expect(planned.plan.prompt).toBeUndefined()
    expect(planned.warning).toContain('書き直せなかった')
  })

  it('曖昧語を開いた長い清書を通す。弾くのは上限を超えたときだけ', () => {
    const long = `Redraw it as a flat vector illustration. ${'Keep the circular layout. '.repeat(
      25,
    )}`.trim()
    expect(long.length).toBeGreaterThan(600)
    expect(
      validateImagePlan(
        { tool: 'image.edit', arguments: {}, reason: 'restyle', prompt: long },
        { hasSourceImage: true, hasEditRegion: false },
      ).prompt,
    ).toBe(long)
    expect(() =>
      validateImagePlan(
        {
          tool: 'image.edit',
          arguments: {},
          reason: 'restyle',
          prompt: 'x'.repeat(MAX_REWRITTEN_PROMPT_LENGTH + 1),
        },
        { hasSourceImage: true, hasEditRegion: false },
      ),
    ).toThrow(/900文字以内/)
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
    // 文字を描けないツールでは黙って落とす（弾くと計画ごと捨てて別の絵になる）
    const rotate = validateImagePlan(
      { tool: 'image.rotate', arguments: { angle: 90, text: 'x' } },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(rotate.tool).toBe('image.rotate')
    expect(rotate.arguments.text).toBeUndefined()
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

  it('画像モデルを使わないツールでは書き直しプロンプトを落とす', () => {
    const plan = validateImagePlan(
      { tool: 'image.rotate', arguments: { angle: 90 }, prompt: 'Rotate it.' },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.tool).toBe('image.rotate')
    expect(plan.prompt).toBeUndefined()
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

describe('画素を作る操作を使わない設定（D-020）', () => {
  const edit = { hasSourceImage: true, hasEditRegion: false, forbidSynthesis: true }

  it('画素を作るツールは計画の段階で断る。実行してからでは遅い', () => {
    for (const tool of ['image.generate', 'image.edit', 'image.erase']) {
      expect(
        () =>
          validateImagePlan(
            { tool, arguments: {} },
            { hasSourceImage: tool !== 'image.generate', hasEditRegion: true, forbidSynthesis: true },
          ),
        `${tool}は断られなければならない`,
      ).toThrow(SynthesisForbiddenError)
    }
  })

  it('画素を作らないツールはそのまま通る', () => {
    expect(ruleBasedPlan('90度回転して', edit).tool).toBe('image.rotate')
    expect(ruleBasedPlan('20%明るくして', edit).tool).toBe('image.brightness')
    expect(ruleBasedPlan('コントラストを30上げて', edit).tool).toBe('image.contrast')
    expect(ruleBasedPlan('正方形に切り抜いて', edit).tool).toBe('image.crop-square')
    expect(ruleBasedPlan('背景を透明にして', edit).tool).toBe('background.remove')
  })

  it('落とし先を作らない。黙って別のツールを動かさない', () => {
    // 規則で確定できない指示は、ふだんは image.edit へ落ちる。そこが禁じられている
    expect(() => ruleBasedPlan('もっといい感じにして', edit)).toThrow(SynthesisForbiddenError)
    expect(() => ruleBasedPlan('もっといい感じにして', edit)).toThrow(/画素を作らない操作/)
  })

  it('画像がまだ無いときは、取り込みへ案内する', () => {
    expect(() =>
      ruleBasedPlan('ロゴを作って', {
        hasSourceImage: false,
        hasEditRegion: false,
        forbidSynthesis: true,
      }),
    ).toThrow(/画像を取り込む/)
  })

  it('設定していなければ、これまでどおり image.edit へ落ちる', () => {
    expect(ruleBasedPlan('もっといい感じにして', { hasSourceImage: true, hasEditRegion: false }).tool).toBe(
      'image.edit',
    )
  })

  it('LLM へ渡す一覧からも外す。見せると選ばれる', () => {
    const open = toolCatalogForPrompt()
    const closed = toolCatalogForPrompt({ forbidSynthesis: true })
    expect(open).toContain('- image.generate:')
    for (const tool of ['image.generate', 'image.edit', 'image.erase']) {
      expect(closed, `${tool}を一覧へ載せてはいけない`).not.toContain(`- ${tool}:`)
    }
    // 一覧から外しても、別のツールの注意書きが image.edit を名指しする。
    // 名指しされても選ばせないと明記しておく
    expect(closed).toContain('Choose only from the tools listed above')
    // 使えるものは残る
    expect(closed).toContain('image.rotate')
    expect(closed).toContain('image.brightness')
  })
})

describe('1つの指示から複数の候補（D-018）', () => {
  const planner = {
    enabled: true,
    provider: 'openai-compatible' as const,
    modelId: 'local',
    apiBase: 'http://localhost:11434/v1',
    apiKey: '',
  }
  const reply = (content: string) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    )

  it('複数を求めている指示に気づく。ただし数は読み取らない', () => {
    // 実際に詰まった指示。全角数字で書かれている
    expect(asksForMultipleCandidates('方向性の違う候補のパターンを３つくらい作ってほしい')).toBe(
      true,
    )
    expect(asksForMultipleCandidates('案を2つ出して')).toBe(true)
    expect(asksForMultipleCandidates('パターンを複数ください')).toBe(true)
    expect(asksForMultipleCandidates('候補を三つ')).toBe(true)
    // 候補の話をしていない指示で誤検知しない
    expect(asksForMultipleCandidates('もっと余白を取って')).toBe(false)
    expect(asksForMultipleCandidates('ロゴを作って')).toBe(false)
    // 「候補」とは言っているが枚数の話がない
    expect(asksForMultipleCandidates('この候補でいきます')).toBe(false)
  })

  it('方向の違う案を受け取る', async () => {
    reply('{"prompts":["A minimal constellation mark.","A dense star map mark."]}')
    const prompts = await proposeVariantPrompts({
      intent: '方向の違う案を出して',
      basePrompt: 'A constellation logo.',
      count: 2,
      planner,
    })
    expect(prompts).toHaveLength(2)
    expect(prompts[0]).not.toBe(prompts[1])
  })

  it('同じ案が返ってきたら候補になっていない。落として seed 違いへ回させる', async () => {
    reply('{"prompts":["Same idea.","Same idea.","Same idea."]}')
    await expect(
      proposeVariantPrompts({
        intent: '案を3つ',
        basePrompt: 'x',
        count: 3,
        planner,
      }),
    ).rejects.toThrow(/方向の違う案/)
  })

  it('描く文字列が決まっているなら、それを落とした案は捨てる', async () => {
    // 文字列が落ちると描画対象が失われる（validateImagePlan と同じ縛り）
    reply('{"prompts":["Wordmark asterism in serif.","A mark with no lettering.","asterism in a circle."]}')
    const prompts = await proposeVariantPrompts({
      intent: '案を出して',
      basePrompt: 'x',
      count: 3,
      text: 'asterism',
      planner,
    })
    expect(prompts).toEqual([
      'Wordmark asterism in serif.',
      'asterism in a circle.',
    ])
  })

  it('上限を超えて要求されても MAX_VARIANTS までしか返さない', async () => {
    reply('{"prompts":["a","b","c","d","e","f"]}')
    const prompts = await proposeVariantPrompts({
      intent: '案を出して',
      basePrompt: 'x',
      count: 99,
      planner,
    })
    expect(prompts).toHaveLength(MAX_VARIANTS)
  })
})

describe('編集の範囲（D-023）', () => {
  it('LLM が答えた範囲を使う', () => {
    const plan = validateImagePlan(
      { tool: 'image.edit', arguments: {}, scope: 'whole' },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.scope).toBe('whole')
    // 指示の言葉が何であれ、答えた側を優先する
    expect(editScopeOf(plan, 'もう少し余白を取って').scope).toBe('whole')
  })

  it('答えなかったら指示の言葉から当てる', () => {
    const plan = validateImagePlan(
      { tool: 'image.edit', arguments: {} },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.scope).toBeUndefined()
    expect(editScopeOf(plan, '同じ方向性で抽象化をしてほしい')).toEqual({
      scope: 'whole',
      source: 'rules',
    })
    // 決めた側も返す。外したときにどちらを直せばよいか分かるようにするため
    expect(editScopeOf(plan, 'もう少し余白を取って')).toEqual({ scope: 'local', source: 'rules' })
  })

  it('知らない値は載せない。語彙の外を通さない', () => {
    const plan = validateImagePlan(
      { tool: 'image.edit', arguments: {}, scope: 'まあまあ変える' },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.scope).toBeUndefined()
  })

  it('画像モデルを使わないツールには載せない', () => {
    const plan = validateImagePlan(
      { tool: 'image.rotate', arguments: { angle: 90 }, scope: 'whole' },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(plan.scope).toBeUndefined()
  })
})

describe('編集の範囲を書き直し文からも当てる（D-023）', () => {
  /** 実測でつまずいた指示と、そのとき実際に走った書き直し文 */
  const real = [
    {
      intent: 'かなりリッチな画像なので、ベタッとしたイラストにしてください',
      prompt: 'Convert the existing rich logo into a flat, solid illustration style.',
    },
    {
      intent: '同じ方向性で抽象化をしてほしい',
      prompt: 'Create a more abstract version of the existing logo, preserving its conceptual direction.',
    },
    {
      intent: 'シンプルなフラットデザインのロゴにしてくれますか',
      prompt: 'Create a simple flat design logo based on the existing rich illustration.',
    },
  ]

  it('利用者の言い回しで拾えなくても、書き直し文で拾う', () => {
    for (const { intent, prompt } of real) {
      const plan = validateImagePlan(
        { tool: 'image.edit', arguments: {}, prompt },
        { hasSourceImage: true, hasEditRegion: false },
      )
      expect(editScopeOf(plan, intent).scope, intent).toBe('whole')
    }
  })

  it('プランナーが local と答えても、作り替えの文なら上げる', () => {
    // ここでやっているのは「矛盾する保存句を外す」ことだけなので、上げる方向にしか動かさない
    const plan = validateImagePlan(
      {
        tool: 'image.edit',
        arguments: {},
        scope: 'local',
        prompt: 'Convert the existing rich logo into a flat, solid illustration style.',
      },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(editScopeOf(plan, 'ベタッとしたイラストに').scope).toBe('whole')
  })

  it('一部を直す依頼は local のまま', () => {
    const plan = validateImagePlan(
      {
        tool: 'image.edit',
        arguments: {},
        prompt: 'Widen the margin around the artwork slightly.',
      },
      { hasSourceImage: true, hasEditRegion: false },
    )
    expect(editScopeOf(plan, 'もう少し余白を取って').scope).toBe('local')
  })
})

describe('日本語のまま渡さない（D-033）', () => {
  it('編集用に組み立てた全文の中に日本語が残っていても見つける', () => {
    // 実際に踏んだ形。英語の枠に日本語が挟まっていても、画像モデルには届かない
    expect(
      needsTranslation(
        'Edit the input image according to this instruction: 痩せたクマにしてください Do not change anything the instruction does not ask you to change.',
      ),
    ).toBe(true)
    // 描く文字列そのものは訳さない。日本語のワードマークは日本語で残る
    expect(needsTranslation('Add the wordmark 熊研究所 below the logo', '熊研究所')).toBe(false)
  })
})
