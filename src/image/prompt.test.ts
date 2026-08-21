import { describe, expect, it } from 'vitest'
import { isTextRemovalIntent, promptForImageGeneration } from './prompt.js'

describe('画像編集用プロンプト', () => {
  it('ロゴタイプの削除指示を検出する', () => {
    expect(isTextRemovalIntent('Asterismという文字（ロゴタイプ）を消してください')).toBe(
      true,
    )
  })

  it('親プロンプトの文字列を削除指示へ持ち込まない', () => {
    const prompt = promptForImageGeneration(
      'a logo with the word Asterism',
      'Asterismという文字（ロゴタイプ）を消してください',
      true,
    )
    expect(prompt).not.toContain('Asterism')
    expect(prompt).toContain('Remove the wordmark')
  })

  it('画像入力がない場合は従来の枝分かれを維持する', () => {
    expect(promptForImageGeneration('base prompt', 'make it blue', false)).toBe(
      'base prompt, make it blue',
    )
  })
})
