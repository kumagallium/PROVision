/**
 * 設定ファイルの置き場と、旧置き場からの一回限りの移行。
 *
 * **なぜ成果物と設定で置き場を分けるのか。**
 *
 * 成果物（lineage.jsonld と画像）は `~/Documents/PROVision` に置く。この道具の
 * 成果は「書き出したファイルそのもの」なので、利用者の手が届く場所に要る。
 *
 * ところが Documents は macOS の TCC 保護対象で、**アプリの署名が変わると
 * 過去に与えた許可が無効化される**。リリースのたびに署名は変わるので、
 * 更新直後のサイドカー（node）は Documents を読めない状態で起動しうる。
 *
 * このとき `existsSync` は「拒否された」ではなく `false` を返す。つまり
 * 「設定ファイルが無い」と区別できない。実際、AI モデルの登録が更新のたびに
 * 消えたように見え、その状態で登録し直すと元の内容ごと上書きされていた。
 *
 * 設定は利用者が直接開くものではないので、TCC 保護外の Application Support へ
 * 置く。Graphium が同じ理由で Documents から移している。
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** 置き場が変わっても持ち越す設定。成果物（画像・グラフ）は対象外 */
export const CONFIG_FILES = ['ai-planner.json', 'identity.json', 'policy.json'] as const

export interface MigrationResult {
  /** 旧置き場から持ってきたもの */
  copied: string[]
  /** 元が無い、または移行先に既にあったもの */
  skipped: string[]
  /** 読めなかったもの。TCC 拒否はここに出る */
  failed: Array<{ name: string; reason: string }>
}

/**
 * 旧置き場（成果物と同じディレクトリ）から設定を **複製** する。
 *
 * 移動ではなく複製にするのは、旧版へ戻したときに設定を失わせないため。
 * 移行先に同名があれば必ず飛ばす——新しい置き場で書いた内容のほうが新しい。
 *
 * 何度呼んでも壊れない。読めないものがあっても起動は続ける（失敗として返すだけ）。
 */
export async function migrateConfigFiles(
  legacyDir: string,
  configDir: string,
): Promise<MigrationResult> {
  const result: MigrationResult = { copied: [], skipped: [], failed: [] }
  if (legacyDir === configDir) return result

  await mkdir(configDir, { recursive: true })

  for (const name of CONFIG_FILES) {
    const to = join(configDir, name)
    if (existsSync(to)) {
      result.skipped.push(name)
      continue
    }
    const from = join(legacyDir, name)
    try {
      // 存在確認だけでは TCC 拒否と不在を見分けられないので、実際に読んで確かめる
      await readFile(from)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT') result.skipped.push(name)
      else result.failed.push({ name, reason: code ?? String(error) })
      continue
    }
    try {
      await copyFile(from, to)
      result.copied.push(name)
    } catch (error) {
      result.failed.push({
        name,
        reason: (error as NodeJS.ErrnoException).code ?? String(error),
      })
    }
  }
  return result
}
