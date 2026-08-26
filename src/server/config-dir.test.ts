import { mkdtemp, mkdir, readFile, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { migrateConfigFiles } from './config-dir.js'

async function dirs() {
  const root = await mkdtemp(join(tmpdir(), 'provision-config-'))
  const legacy = join(root, 'legacy')
  const config = join(root, 'config')
  await mkdir(legacy, { recursive: true })
  return { legacy, config }
}

describe('設定の引き継ぎ', () => {
  it('旧置き場にある設定を複製する。元は消さない', async () => {
    const { legacy, config } = await dirs()
    await writeFile(join(legacy, 'ai-planner.json'), '{"models":[1]}', 'utf8')

    const result = await migrateConfigFiles(legacy, config)

    expect(result.copied).toContain('ai-planner.json')
    expect(await readFile(join(config, 'ai-planner.json'), 'utf8')).toBe('{"models":[1]}')
    // 旧版へ戻したときに設定を失わせないので、元は残す
    expect(await readFile(join(legacy, 'ai-planner.json'), 'utf8')).toBe('{"models":[1]}')
  })

  it('移行先に既にあれば上書きしない', async () => {
    const { legacy, config } = await dirs()
    await mkdir(config, { recursive: true })
    await writeFile(join(legacy, 'ai-planner.json'), 'old', 'utf8')
    await writeFile(join(config, 'ai-planner.json'), 'new', 'utf8')

    const result = await migrateConfigFiles(legacy, config)

    expect(result.skipped).toContain('ai-planner.json')
    expect(await readFile(join(config, 'ai-planner.json'), 'utf8')).toBe('new')
  })

  it('何度呼んでも壊れない', async () => {
    const { legacy, config } = await dirs()
    await writeFile(join(legacy, 'identity.json'), 'x', 'utf8')

    await migrateConfigFiles(legacy, config)
    const second = await migrateConfigFiles(legacy, config)

    expect(second.copied).toEqual([])
    expect(second.skipped).toContain('identity.json')
    expect(await readFile(join(config, 'identity.json'), 'utf8')).toBe('x')
  })

  it('読めない設定は「無かった」ことにせず、失敗として返す', async () => {
    // TCC で拒否されたときに、不在と取り違えて空で上書きしないことの砦
    const { legacy, config } = await dirs()
    const path = join(legacy, 'policy.json')
    await writeFile(path, 'secret', 'utf8')
    await chmod(path, 0o000)

    const result = await migrateConfigFiles(legacy, config)

    // root で走ると権限を無視して読めてしまうので、その場合は複製されていればよい
    if (result.failed.length > 0) {
      expect(result.failed[0]!.name).toBe('policy.json')
      expect(result.skipped).not.toContain('policy.json')
    } else {
      expect(result.copied).toContain('policy.json')
    }
    await chmod(path, 0o600)
  })

  it('置き場が同じなら何もしない', async () => {
    const { legacy } = await dirs()
    const result = await migrateConfigFiles(legacy, legacy)
    expect(result).toEqual({ copied: [], skipped: [], failed: [] })
  })
})
