import { describe, expect, it } from 'vitest'
import { isRemovalIntent, isTextRemovalIntent, promptForImageGeneration } from './prompt.js'

describe('画像編集用プロンプト', () => {
  it('ロゴタイプの削除指示を検出する', () => {
    expect(isTextRemovalIntent('Asterismという文字（ロゴタイプ）を消してください')).toBe(
      true,
    )
  })

  it('文字以外の削除指示も検出する', () => {
    expect(isRemovalIntent('選択した人物を取り除いて')).toBe(true)
    expect(isRemovalIntent('選択した傷を修復して')).toBe(true)
    expect(isRemovalIntent('選択した部分を赤くして')).toBe(false)
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

  it('指定範囲だけを編集する指示を含める', () => {
    const prompt = promptForImageGeneration(undefined, '背景を消す', true, true)
    expect(prompt).toContain('Edit only the selected region')
  })
})
