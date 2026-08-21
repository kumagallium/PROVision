const TEXT_TERMS =
  /(文字|テキスト|ロゴ|ロゴタイプ|ロゴマーク|ワードマーク|英字|名前|text|lettering|logo|wordmark|watermark|brand)/i
const REMOVE_TERMS =
  /(消|削除|除去|取り除|なく|無く|remove|delete|erase|without|no\s+)/i

export function isTextRemovalIntent(intent: string): boolean {
  return TEXT_TERMS.test(intent) && REMOVE_TERMS.test(intent)
}

/**
 * 親画像を入力できる場合は、親のテキストプロンプトを再利用しない。
 * 親プロンプトに含まれる文字列が、編集指示と競合して再描画されるため。
 */
export function promptForImageGeneration(
  parentPrompt: string | undefined,
  intent: string,
  hasSourceImage: boolean,
  hasEditRegion = false,
): string {
  if (!parentPrompt || !hasSourceImage) {
    const base = parentPrompt ? `${parentPrompt}, ${intent}` : intent
    return hasSourceImage && hasEditRegion
      ? `${base} Edit only the selected region and blend it seamlessly with the surrounding image.`
      : base
  }

  if (isTextRemovalIntent(intent)) {
    return [
      'Edit the input image.',
      ...(hasEditRegion ? ['Edit only the selected region and blend it seamlessly with the surrounding image.'] : []),
      'Remove the wordmark and all lettering from the logo.',
      'Preserve the symbol, line geometry, colors, composition, and background.',
      'Do not add any text, logo, brand name, or watermark.',
    ].join(' ')
  }

  return [
    'Edit the input image according to this instruction:',
    intent,
    ...(hasEditRegion ? ['Edit only the selected region and blend it seamlessly with the surrounding image.'] : []),
    'Preserve all existing visual elements, composition, colors, and geometry unless explicitly changed.',
    'Do not add any text, logo, brand name, or watermark unless explicitly requested.',
  ].join(' ')
}
