import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchAvailableModels, resolveAiApiBase } from './provider.js'

afterEach(() => vi.unstubAllGlobals())

describe('AIプロバイダー', () => {
  it('Ollama互換APIからモデル一覧を取得する', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: 'qwen2.5:3b' }, { id: 'gemma3:4b' }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchAvailableModels({
        provider: 'openai-compatible',
        apiBase: 'http://127.0.0.1:11434/v1',
        apiKey: '',
      }),
    ).resolves.toEqual(['gemma3:4b', 'qwen2.5:3b'])
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({ headers: {} }),
    )
  })

  it('Geminiでは生成可能なモデルだけを返す', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            models: [
              { name: 'models/gemini-test', supportedGenerationMethods: ['generateContent'] },
              { name: 'models/embed-test', supportedGenerationMethods: ['embedContent'] },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    )
    await expect(
      fetchAvailableModels({
        provider: 'google',
        apiBase: '',
        apiKey: 'test-key',
      }),
    ).resolves.toEqual(['gemini-test'])
  })

  it('安全でないHTTP接続先を拒否する', () => {
    expect(() =>
      resolveAiApiBase({ provider: 'openai-compatible', apiBase: 'http://example.com/v1' }),
    ).toThrow('HTTPS')
  })
})
