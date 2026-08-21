import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type AiProvider = 'anthropic' | 'openai' | 'google' | 'openai-compatible'

export interface AiPlannerConfig {
  enabled: boolean
  provider: AiProvider
  modelId: string
  apiBase: string
}

export interface PublicAiPlannerConfig extends AiPlannerConfig {
  hasApiKey: boolean
  keyStorage: 'keychain' | 'memory'
}

const DEFAULT_CONFIG: AiPlannerConfig = {
  enabled: false,
  provider: 'openai-compatible',
  modelId: '',
  apiBase: 'http://127.0.0.1:11434/v1',
}
const KEYCHAIN_SERVICE = 'com.provision.app'
const KEYCHAIN_ACCOUNT = 'image-planner'
let memoryApiKey = ''

function configPath(dataDir: string): string {
  return join(dataDir, 'ai-planner.json')
}

function keychainEnabled(): boolean {
  return process.platform === 'darwin' && process.env.PROVISION_USE_KEYCHAIN === '1'
}

function readKeychain(): string {
  if (!keychainEnabled()) return memoryApiKey
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).replace(/\r?\n$/, '')
  } catch {
    return ''
  }
}

function writeKeychain(apiKey: string): void {
  if (!keychainEnabled()) {
    memoryApiKey = apiKey
    return
  }
  if (!apiKey) {
    try {
      execFileSync(
        'security',
        ['delete-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT],
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
      KEYCHAIN_ACCOUNT,
      '-w',
      apiKey,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  )
}

function normalizeConfig(value: Partial<AiPlannerConfig>): AiPlannerConfig {
  const providers: AiProvider[] = ['anthropic', 'openai', 'google', 'openai-compatible']
  const provider = providers.includes(value.provider as AiProvider)
    ? (value.provider as AiProvider)
    : DEFAULT_CONFIG.provider
  return {
    enabled: Boolean(value.enabled),
    provider,
    modelId: String(value.modelId ?? '').trim().slice(0, 200),
    apiBase: String(value.apiBase ?? '').trim().slice(0, 500),
  }
}

export async function readAiPlannerConfig(dataDir: string): Promise<AiPlannerConfig> {
  const path = configPath(dataDir)
  if (!existsSync(path)) return { ...DEFAULT_CONFIG }
  try {
    return normalizeConfig(JSON.parse(await readFile(path, 'utf8')) as Partial<AiPlannerConfig>)
  } catch (error) {
    throw new Error(
      `AIプランナー設定を読めません: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}

export async function publicAiPlannerConfig(
  dataDir: string,
): Promise<PublicAiPlannerConfig> {
  const config = await readAiPlannerConfig(dataDir)
  return {
    ...config,
    hasApiKey: readKeychain().length > 0,
    keyStorage: keychainEnabled() ? 'keychain' : 'memory',
  }
}

export async function saveAiPlannerConfig(
  dataDir: string,
  input: Partial<AiPlannerConfig> & { apiKey?: string; clearApiKey?: boolean },
): Promise<PublicAiPlannerConfig> {
  const current = await readAiPlannerConfig(dataDir)
  const config = normalizeConfig({ ...current, ...input })
  await writeFile(configPath(dataDir), `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  const endpointChanged =
    config.provider !== current.provider || config.apiBase !== current.apiBase
  if (input.clearApiKey || (endpointChanged && !input.apiKey?.trim())) writeKeychain('')
  else if (input.apiKey?.trim()) writeKeychain(input.apiKey.trim())
  return publicAiPlannerConfig(dataDir)
}

export async function plannerCredentials(
  dataDir: string,
): Promise<AiPlannerConfig & { apiKey: string }> {
  return { ...(await readAiPlannerConfig(dataDir)), apiKey: readKeychain() }
}
