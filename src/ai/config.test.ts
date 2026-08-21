import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  plannerCredentials,
  publicAiPlannerConfig,
  saveAiPlannerConfig,
} from './config.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('AIプランナー設定', () => {
  it('APIキーを設定JSONへ書かない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provision-ai-config-'))
    dirs.push(dir)
    await saveAiPlannerConfig(dir, {
      enabled: true,
      provider: 'openai-compatible',
      modelId: 'qwen2.5:3b',
      apiBase: 'http://127.0.0.1:11434/v1',
      apiKey: 'not-written-to-disk',
    })
    expect(await readFile(join(dir, 'ai-planner.json'), 'utf8')).not.toContain(
      'not-written-to-disk',
    )
    expect((await publicAiPlannerConfig(dir)).hasApiKey).toBe(true)
    expect((await plannerCredentials(dir)).apiKey).toBe('not-written-to-disk')
  })

  it('接続先を変えたとき以前のAPIキーを引き継がない', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'provision-ai-config-'))
    dirs.push(dir)
    await saveAiPlannerConfig(dir, {
      provider: 'openai',
      modelId: 'gpt-test',
      apiKey: 'openai-secret',
    })
    await saveAiPlannerConfig(dir, {
      provider: 'openai-compatible',
      apiBase: 'https://example.com/v1',
    })
    expect((await plannerCredentials(dir)).apiKey).toBe('')
  })
})
