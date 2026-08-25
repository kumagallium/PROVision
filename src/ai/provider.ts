import type { AiPlannerConfig, AiProvider } from './config.js'

export const AI_PROVIDERS: Array<{
  id: AiProvider
  name: string
  defaultApiBase: string
}> = [
  { id: 'anthropic', name: 'Anthropic', defaultApiBase: 'https://api.anthropic.com' },
  { id: 'openai', name: 'OpenAI', defaultApiBase: 'https://api.openai.com/v1' },
  {
    id: 'google',
    name: 'Google Gemini',
    defaultApiBase: 'https://generativelanguage.googleapis.com',
  },
  {
    id: 'openai-compatible',
    name: 'OpenAI互換（Ollama、Groqなど）',
    defaultApiBase: 'http://127.0.0.1:11434/v1',
  },
]

export function isAiProvider(value: unknown): value is AiProvider {
  return AI_PROVIDERS.some((provider) => provider.id === value)
}

export function resolveAiApiBase(
  config: Pick<AiPlannerConfig, 'provider' | 'apiBase'>,
): string {
  const fallback = AI_PROVIDERS.find((provider) => provider.id === config.provider)?.defaultApiBase
  if (!fallback) throw new Error(`対応していないAIプロバイダーです: ${config.provider}`)
  const url = new URL(config.apiBase.trim() || fallback)
  const local = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new Error('AI API BaseはHTTPSまたはローカルホストだけ指定できます')
  }
  return url.toString().replace(/\/$/, '')
}

async function providerError(provider: string, response: Response): Promise<Error> {
  if (response.status === 401) return new Error(`${provider}のAPIキーが無効です`)
  if (response.status === 403) return new Error(`${provider}のAPIキーに権限がありません`)
  return new Error(`${provider}のモデル一覧を取得できませんでした（${response.status}）`)
}

export async function fetchAvailableModels(
  config: Pick<AiPlannerConfig, 'provider' | 'apiBase'> & {
    apiKey: string
    signal?: AbortSignal
  },
): Promise<string[]> {
  const base = resolveAiApiBase(config)
  const timeout = AbortSignal.timeout(30_000)
  const signal = config.signal ? AbortSignal.any([config.signal, timeout]) : timeout

  if (config.provider === 'anthropic') {
    if (!config.apiKey) throw new Error('Anthropic APIキーを入力してください')
    const apiBase = base.endsWith('/v1') ? base : `${base}/v1`
    const models: string[] = []
    let afterId = ''
    do {
      const query = new URLSearchParams({ limit: '100' })
      if (afterId) query.set('after_id', afterId)
      const response = await fetch(`${apiBase}/models?${query}`, {
        signal,
        headers: {
          'x-api-key': config.apiKey,
          'anthropic-version': '2023-06-01',
        },
      })
      if (!response.ok) throw await providerError('Anthropic', response)
      const body = (await response.json()) as {
        data?: Array<{ id?: string }>
        has_more?: boolean
        last_id?: string
      }
      models.push(
        ...(body.data ?? []).flatMap((model) =>
          typeof model.id === 'string' ? [model.id] : [],
        ),
      )
      afterId = body.has_more ? (body.last_id ?? '') : ''
    } while (afterId)
    return [...new Set(models)].sort()
  }

  if (config.provider === 'google') {
    if (!config.apiKey) throw new Error('Google APIキーを入力してください')
    const models: string[] = []
    let pageToken = ''
    do {
      const query = new URLSearchParams({ key: config.apiKey, pageSize: '100' })
      if (pageToken) query.set('pageToken', pageToken)
      const response = await fetch(`${base}/v1beta/models?${query}`, { signal })
      if (!response.ok) throw await providerError('Google', response)
      const body = (await response.json()) as {
        models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>
        nextPageToken?: string
      }
      for (const model of body.models ?? []) {
        if (!model.supportedGenerationMethods?.includes('generateContent')) continue
        const id = model.name?.replace(/^models\//, '')
        if (id) models.push(id)
      }
      pageToken = body.nextPageToken ?? ''
    } while (pageToken)
    return [...new Set(models)].sort()
  }

  if (config.provider === 'openai' && !config.apiKey) {
    throw new Error('OpenAI APIキーを入力してください')
  }
  const response = await fetch(`${base}/models`, {
    signal,
    headers: config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {},
  })
  if (!response.ok) throw await providerError('OpenAI互換API', response)
  const body = (await response.json()) as { data?: Array<{ id?: string }> }
  return [
    ...new Set(
      (body.data ?? []).flatMap((model) =>
        typeof model.id === 'string' ? [model.id] : [],
      ),
    ),
  ].sort()
}
