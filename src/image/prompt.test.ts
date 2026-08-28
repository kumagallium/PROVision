import { describe, expect, it } from 'vitest'
import {
  isRemovalIntent,
  isTextAdditionIntent,
  isWholeImageIntent,
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

  it('プランナーが推定した文字列を描画対象として使う', () => {
    const prompt = promptForImageGeneration(
      'a constellation logo',
      'ロゴタイプを追加してください',
      true,
      false,
      'asterism',
    )
    expect(prompt).toContain('Add the exact text "asterism"')
    expect(prompt).not.toContain('Do not add')
  })

  it('指定範囲だけを編集する指示を含める', () => {
    const prompt = promptForImageGeneration(undefined, '背景を消す', true, true)
    expect(prompt).toContain('Edit only the selected region')
  })
})

describe('全体を作り替える依頼（D-023）', () => {
  const PRESERVE = 'Preserve all existing visual elements'

  it('作り替えの依頼へ「すべて保て」を付けない。自己矛盾で絵が変わらなくなる', () => {
    // 実測でつまずいた 2 件。どちらも保存句のせいで絵がほとんど変わらなかった
    for (const intent of [
      'シンプルなフラットデザインのロゴにしてくれますか',
      '同じ方向性で抽象化をしてほしい',
    ]) {
      const prompt = promptForImageGeneration(
        'a rich isometric icon',
        intent,
        true,
        false,
        undefined,
        'whole',
      )
      expect(prompt, intent).not.toContain(PRESERVE)
      expect(prompt, intent).toContain('expected to look clearly different')
      // 頼まれていない文字は、作り替えでも足させない
      expect(prompt).toContain('Do not add any text')
    }
  })

  it('一部を直す依頼では、指示の外を変えるなと伝える', () => {
    const prompt = promptForImageGeneration(
      'a rich isometric icon',
      'もう少し余白を取って',
      true,
      false,
      undefined,
      'local',
    )
    expect(prompt).toContain('Do not change anything the instruction does not ask you to change')
  })

  it('既定は local。範囲が分からないのに作り替えさせない', () => {
    expect(
      promptForImageGeneration('a rich isometric icon', 'もう少し余白を取って', true),
    ).toContain('Do not change anything the instruction does not ask you to change')
  })

  it('**保存を求める文は絶対形で書かない。** 範囲を外しても矛盾しない形にする', () => {
    // 範囲の判定を外したとき（作り替えの依頼を local と見た）でも、
    // 文どうしが打ち消し合わないことがこの決定の肝（D-023）
    for (const scope of ['local', 'whole'] as const) {
      for (const intent of ['ベタッとしたイラストにして', 'もう少し余白を取って']) {
        const prompt = promptForImageGeneration('a rich icon', intent, true, false, undefined, scope)
        expect(prompt, `${scope} / ${intent}`).not.toContain(PRESERVE)
        expect(prompt).not.toContain('Preserve the existing symbol')
      }
    }
  })

  it('指示の言葉から当てる（LLM が答えなかったときの受け皿）', () => {
    expect(isWholeImageIntent('同じ方向性で抽象化をしてほしい')).toBe(true)
    expect(isWholeImageIntent('シンプルなフラットデザインのロゴにしてくれますか')).toBe(true)
    expect(isWholeImageIntent('make it flat and minimal')).toBe(true)
    // 一部を直す依頼で誤って作り替えさせない
    expect(isWholeImageIntent('もう少し余白を取って')).toBe(false)
    expect(isWholeImageIntent('「asterism」の文字を少し小さくして')).toBe(false)
  })

  it('清書を、文字消しの定型文で置き換えない', () => {
    // 実測: 「弓だけを消して、単色にして、フラット化して」の清書に logo と remove が
    // 入っていたため文字消しと判定され、依頼が 3 つとも消えた版が残っている
    const rewritten =
      'Remove the bow from the logo. Redraw it as a flat vector illustration in one single ink colour; no second colour, no gradients.'
    const prompt = promptForImageGeneration(
      'a rich constellation emblem',
      rewritten,
      true,
      false,
      undefined,
      'whole',
      true,
    )
    expect(prompt).toContain('Remove the bow from the logo')
    expect(prompt).toContain('one single ink colour')
    expect(prompt).not.toContain('Remove the wordmark and all lettering')
    // 単色化を打ち消していた文
    expect(prompt).not.toContain('Preserve the symbol, line geometry, colors')
  })

  it('清書が無いときは、従来どおり文字消しの定型文を使う', () => {
    const prompt = promptForImageGeneration(
      'a logo with the word Asterism',
      'Asterismという文字（ロゴタイプ）を消してください',
      true,
    )
    expect(prompt).toContain('Remove the wordmark')
  })
})
