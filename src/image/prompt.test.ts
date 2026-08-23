import { describe, expect, it } from 'vitest'
import {
  isRemovalIntent,
  isTextAdditionIntent,
  isTextRemovalIntent,
  promptForImageGeneration,
} from './prompt.js'

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

  it('ロゴタイプの追加指示を検出する', () => {
    expect(isTextAdditionIntent('ロゴタイプをつけてくれますか？')).toBe(true)
    expect(isTextAdditionIntent('「asterism」という文字を下に入れて')).toBe(true)
    expect(isTextAdditionIntent('ロゴタイプを消して')).toBe(false)
    expect(isTextAdditionIntent('文字を入れないで')).toBe(false)
  })

  it('追加指示では「文字を足すな」の禁止文を付けない', () => {
    const prompt = promptForImageGeneration(
      'a constellation logo',
      'ロゴタイプをつけてくれますか？',
      true,
    )
    expect(prompt).not.toContain('Do not add')
    expect(prompt).toContain('Render the lettering cleanly')
  })

  it('鉤括弧で指定された文字列を描画対象として明示する', () => {
    const prompt = promptForImageGeneration(
      'a constellation logo',
      '「asterism」というロゴタイプを下に付けて',
      true,
    )
    expect(prompt).toContain('Add the exact text "asterism"')
  })

  it('指定範囲だけを編集する指示を含める', () => {
    const prompt = promptForImageGeneration(undefined, '背景を消す', true, true)
    expect(prompt).toContain('Edit only the selected region')
  })
})
