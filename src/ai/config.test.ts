import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  plannerCredentials,
  publicAiModelRegistry,
  registerAiModel,
  removeAiModel,
  updateAiModelSelection,
} from './config.js'

const dirs: string[] = []

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'provision-ai-config-'))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('AIモデル設定', () => {
  it('複数モデルを登録してTool Routerへ割り当てる', async () => {
    const dir = await tempDir()
    let registry = await registerAiModel(dir, {
      name: 'ローカル',
      provider: 'openai-compatible',
      modelId: 'qwen2.5:3b',
      apiBase: 'http://127.0.0.1:11434/v1',
    })
    registry = await registerAiModel(dir, {
      name: 'OpenAI',
      provider: 'openai',
      modelId: 'gpt-test',
      apiBase: 'https://api.openai.com/v1',
      apiKey: 'not-written-to-disk',
    })

    const openai = registry.models.find((model) => model.modelId === 'gpt-test')
    expect(openai?.hasApiKey).toBe(true)
    registry = await updateAiModelSelection(dir, {
      enabled: true,
      selectedModelId: openai?.id,
    })
    expect(registry.models).toHaveLength(2)
    expect(registry.selectedModelId).toBe(openai?.id)
    expect(await readFile(join(dir, 'ai-planner.json'), 'utf8')).not.toContain(
      'not-written-to-disk',
    )
    expect(await plannerCredentials(dir)).toMatchObject({
      enabled: true,
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'not-written-to-disk',
    })
  })

  it('旧単一設定を登録済みモデルへ移行する', async () => {
    const dir = await tempDir()
    await writeFile(
      join(dir, 'ai-planner.json'),
      JSON.stringify({
        enabled: true,
        provider: 'openai-compatible',
        modelId: 'qwen2.5:3b',
        apiBase: 'http://127.0.0.1:11434/v1/',
      }),
    )

    const registry = await publicAiModelRegistry(dir)
    expect(registry.models).toHaveLength(1)
    expect(registry.selectedModelId).toBe(registry.models[0]?.id)
    expect(await plannerCredentials(dir)).toMatchObject({
      enabled: true,
      provider: 'openai-compatible',
      modelId: 'qwen2.5:3b',
      apiBase: 'http://127.0.0.1:11434/v1',
    })
  })

  it('選択中モデルを削除すると残ったモデルへ切り替える', async () => {
    const dir = await tempDir()
    let registry = await registerAiModel(dir, {
      provider: 'openai-compatible',
      modelId: 'model-a',
      apiBase: 'http://127.0.0.1:11434/v1',
    })
    registry = await registerAiModel(dir, {
      provider: 'openai-compatible',
      modelId: 'model-b',
      apiBase: 'http://127.0.0.1:11434/v1',
    })
    const selected = registry.models.find((model) => model.modelId === 'model-b')
    registry = await updateAiModelSelection(dir, {
      enabled: true,
      selectedModelId: selected?.id,
    })

    registry = await removeAiModel(dir, registry.selectedModelId)
    expect(registry.models.map((model) => model.modelId)).toEqual(['model-a'])
    expect(registry.selectedModelId).toBe(registry.models[0]?.id)
  })

  it('文字列の有効フラグを拒否する', async () => {
    const dir = await tempDir()
    const registry = await registerAiModel(dir, {
      provider: 'openai-compatible',
      modelId: 'model-a',
      apiBase: 'http://127.0.0.1:11434/v1',
    })
    await expect(
      updateAiModelSelection(dir, {
        enabled: 'false',
        selectedModelId: registry.selectedModelId,
      }),
    ).rejects.toThrow('有効・無効')
  })

  it('同時に登録したモデルを失わない', async () => {
    const dir = await tempDir()
    await Promise.all([
      registerAiModel(dir, {
        provider: 'openai-compatible',
        modelId: 'model-a',
        apiBase: 'http://127.0.0.1:11434/v1',
      }),
      registerAiModel(dir, {
        provider: 'openai-compatible',
        modelId: 'model-b',
        apiBase: 'http://127.0.0.1:11434/v1',
      }),
    ])

    const registry = await publicAiModelRegistry(dir)
    expect(registry.models.map((model) => model.modelId)).toEqual(['model-a', 'model-b'])
  })
})
