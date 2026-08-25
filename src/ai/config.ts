import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveAiApiBase } from './provider.js'

export type AiProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible'

export interface AiPlannerConfig {
  enabled: boolean
  provider: AiProvider
  modelId: string
  apiBase: string
}

export interface RegisteredAiModel {
  id: string
  name: string
  provider: AiProvider
  modelId: string
  apiBase: string
}

export interface AiModelRegistry {
  enabled: boolean
  selectedModelId: string
  models: RegisteredAiModel[]
}

export interface PublicRegisteredAiModel extends RegisteredAiModel {
  hasApiKey: boolean
}

export interface PublicAiModelRegistry {
  enabled: boolean
  selectedModelId: string
  models: PublicRegisteredAiModel[]
  keyStorage: 'keychain' | 'memory'
}

const DEFAULT_PLANNER: AiPlannerConfig = {
  enabled: false,
  provider: 'openai-compatible',
  modelId: '',
  apiBase: 'http://127.0.0.1:11434/v1',
}
const DEFAULT_REGISTRY: AiModelRegistry = {
  enabled: false,
  selectedModelId: '',
  models: [],
}
const KEYCHAIN_SERVICE = 'com.provision.app'
const LEGACY_KEYCHAIN_ACCOUNT = 'image-planner'
const memoryApiKeys = new Map<string, string>()
const registryMutations = new Map<string, Promise<unknown>>()

function configPath(dataDir: string): string {
  return join(dataDir, 'ai-planner.json')
}

function keychainEnabled(): boolean {
  return process.platform === 'darwin' && process.env.PROVISION_USE_KEYCHAIN === '1'
}

function readSecret(account: string): string {
  if (!keychainEnabled()) return memoryApiKeys.get(account) ?? ''
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).replace(/\r?\n$/, '')
  } catch {
    return ''
  }
}

function writeSecret(account: string, apiKey: string): void {
  if (!keychainEnabled()) {
    if (apiKey) memoryApiKeys.set(account, apiKey)
    else memoryApiKeys.delete(account)
    return
  }
  if (!apiKey) {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account],
        { stdio: 'ignore' },
      )
    } catch {
      // 既に無ければ削除済みとして扱う
    }
    return
  }
  execFileSync(
    'security',
    [
      'add-generic-password',
      '-U',
      '-s',
      KEYCHAIN_SERVICE,
      '-a',
      account,
      '-w',
      apiKey,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
}

function isProvider(value: unknown): value is AiProvider {
  return ['anthropic', 'openai', 'google', 'openai-compatible'].includes(String(value))
}

function clean(value: unknown, max: number): string {
  return String(value ?? '').trim().slice(0, max)
}

function defaultRegistry(): AiModelRegistry {
  return { ...DEFAULT_REGISTRY, models: [] }
}

function modelIdFor(input: Pick<RegisteredAiModel, 'provider' | 'apiBase' | 'modelId'>): string {
  const digest = createHash('sha256')
    .update(`${input.provider}\0${input.apiBase}\0${input.modelId}`)
    .digest('hex')
    .slice(0, 16)
  return `model-${digest}`
}

function connectionAccount(
  input: Pick<RegisteredAiModel, 'provider' | 'apiBase'>,
): string {
  const digest = createHash('sha256')
    .update(`${input.provider}\0${input.apiBase}`)
    .digest('hex')
    .slice(0, 24)
  return `image-provider-${digest}`
}

function normalizeModel(value: Partial<RegisteredAiModel>): RegisteredAiModel | null {
  if (!isProvider(value.provider)) return null
  const modelId = clean(value.modelId, 200)
  if (!modelId) return null
  const apiBase = resolveAiApiBase({
    provider: value.provider,
    apiBase: clean(value.apiBase, 500),
  })
  const normalized = {
    provider: value.provider,
    modelId,
    apiBase,
  }
  return {
    id: modelIdFor(normalized),
    name: clean(value.name, 200) || modelId,
    ...normalized,
  }
}

function normalizeRegistry(value: unknown): AiModelRegistry {
  if (!value || typeof value !== 'object') return defaultRegistry()
  const raw = value as {
    enabled?: unknown
    selectedModelId?: unknown
    models?: unknown
    provider?: unknown
    modelId?: unknown
    apiBase?: unknown
  }
  if (Array.isArray(raw.models)) {
    const models = raw.models.flatMap((model) => {
      const normalized = normalizeModel(model as Partial<RegisteredAiModel>)
      return normalized ? [normalized] : []
    })
    const selected = clean(raw.selectedModelId, 100)
    return {
      enabled: Boolean(raw.enabled) && models.length > 0,
      selectedModelId: models.some((model) => model.id === selected)
        ? selected
        : (models[0]?.id ?? ''),
      models,
    }
  }

  const legacy = normalizeModel({
    provider: raw.provider as AiProvider,
    modelId: clean(raw.modelId, 200),
    apiBase: clean(raw.apiBase, 500),
  })
  if (!legacy) return defaultRegistry()
  const legacyKey = readSecret(LEGACY_KEYCHAIN_ACCOUNT)
  const account = connectionAccount(legacy)
  if (legacyKey && !readSecret(account)) writeSecret(account, legacyKey)
  return {
    enabled: Boolean(raw.enabled),
    selectedModelId: legacy.id,
    models: [legacy],
  }
}

async function writeRegistry(dataDir: string, registry: AiModelRegistry): Promise<void> {
  const path = configPath(dataDir)
  const temporary = `${path}.tmp-${process.pid}`
  await writeFile(temporary, `${JSON.stringify(registry, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

function withRegistryMutation<T>(dataDir: string, action: () => Promise<T>): Promise<T> {
  const previous = registryMutations.get(dataDir) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(action)
  registryMutations.set(dataDir, current)
  const cleanup = () => {
    if (registryMutations.get(dataDir) === current) registryMutations.delete(dataDir)
  }
  void current.then(cleanup, cleanup)
  return current
}

export async function readAiModelRegistry(dataDir: string): Promise<AiModelRegistry> {
  const path = configPath(dataDir)
  if (!existsSync(path)) return defaultRegistry()
  try {
    return normalizeRegistry(JSON.parse(await readFile(path, 'utf8')))
  } catch (error) {
    throw new Error(
      `AIモデル設定を読めません: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function publicAiModelRegistry(
  dataDir: string,
): Promise<PublicAiModelRegistry> {
  const registry = await readAiModelRegistry(dataDir)
  return {
    ...registry,
    models: registry.models.map((model) => ({
      ...model,
      hasApiKey: readSecret(connectionAccount(model)).length > 0,
    })),
    keyStorage: keychainEnabled() ? 'keychain' : 'memory',
  }
}

export async function registerAiModel(
  dataDir: string,
  input: Partial<RegisteredAiModel> & { apiKey?: string; replaceId?: string },
): Promise<PublicAiModelRegistry> {
  return withRegistryMutation(dataDir, async () => {
    const model = normalizeModel(input)
    if (!model) throw new Error('プロバイダーとモデルIDを指定してください')
    const registry = await readAiModelRegistry(dataDir)
    // idは接続先とモデルIDから決まるので、編集でそれらが変わると別のidになる。
    // 元の行を畳んでおかないと、編集したつもりで増える
    const replaceId = clean(input.replaceId, 100)
    const replaced = replaceId ? registry.models.find((item) => item.id === replaceId) : undefined
    if (replaceId && !replaced) throw new Error('登録されていないAIモデルです')
    if (replaced && replaced.id !== model.id) {
      registry.models = registry.models.filter((item) => item.id !== replaced.id)
      if (registry.selectedModelId === replaced.id) registry.selectedModelId = model.id
    }
    const index = registry.models.findIndex((item) => item.id === model.id)
    if (index >= 0) registry.models[index] = model
    else registry.models.push(model)
    if (!registry.selectedModelId) registry.selectedModelId = model.id
    if (input.apiKey?.trim()) writeSecret(connectionAccount(model), input.apiKey.trim())
    await writeRegistry(dataDir, registry)
    // 付け替えで誰も使わなくなった接続先の鍵は残さない
    if (replaced && connectionAccount(replaced) !== connectionAccount(model)) {
      const stillUsed = registry.models.some(
        (item) => connectionAccount(item) === connectionAccount(replaced),
      )
      if (!stillUsed) writeSecret(connectionAccount(replaced), '')
    }
    return publicAiModelRegistry(dataDir)
  })
}

export async function updateAiModelSelection(
  dataDir: string,
  input: { enabled?: unknown; selectedModelId?: unknown },
): Promise<PublicAiModelRegistry> {
  return withRegistryMutation(dataDir, async () => {
    const registry = await readAiModelRegistry(dataDir)
    if (typeof input.enabled !== 'boolean') {
      throw new Error('AIによるツール選択の有効・無効を指定してください')
    }
    const selectedModelId = clean(input.selectedModelId, 100)
    if (selectedModelId && !registry.models.some((model) => model.id === selectedModelId)) {
      throw new Error('登録されていないAIモデルです')
    }
    if (input.enabled && !selectedModelId) {
      throw new Error('Tool Routerで使うAIモデルを選んでください')
    }
    registry.enabled = input.enabled
    registry.selectedModelId = selectedModelId
    await writeRegistry(dataDir, registry)
    return publicAiModelRegistry(dataDir)
  })
}

export async function removeAiModel(
  dataDir: string,
  id: string,
): Promise<PublicAiModelRegistry> {
  return withRegistryMutation(dataDir, async () => {
    const registry = await readAiModelRegistry(dataDir)
    const removed = registry.models.find((model) => model.id === id)
    if (!removed) throw new Error('登録されていないAIモデルです')
    registry.models = registry.models.filter((model) => model.id !== id)
    if (registry.selectedModelId === id) {
      registry.selectedModelId = registry.models[0]?.id ?? ''
    }
    if (!registry.selectedModelId) registry.enabled = false
    const connectionStillUsed = registry.models.some(
      (model) => model.provider === removed.provider && model.apiBase === removed.apiBase,
    )
    await writeRegistry(dataDir, registry)
    if (!connectionStillUsed) writeSecret(connectionAccount(removed), '')
    return publicAiModelRegistry(dataDir)
  })
}

export async function modelCredentials(
  dataDir: string,
  id: string,
): Promise<RegisteredAiModel & { apiKey: string }> {
  const registry = await readAiModelRegistry(dataDir)
  const model = registry.models.find((item) => item.id === id)
  if (!model) throw new Error('登録されていないAIモデルです')
  return { ...model, apiKey: readSecret(connectionAccount(model)) }
}

export async function plannerCredentials(
  dataDir: string,
): Promise<AiPlannerConfig & { apiKey: string }> {
  const registry = await readAiModelRegistry(dataDir)
  const model = registry.models.find((item) => item.id === registry.selectedModelId)
  if (!model) return { ...DEFAULT_PLANNER, enabled: false, apiKey: '' }
  return {
    enabled: registry.enabled,
    provider: model.provider,
    modelId: model.modelId,
    apiBase: model.apiBase,
    apiKey: readSecret(connectionAccount(model)),
  }
}
