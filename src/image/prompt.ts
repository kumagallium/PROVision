const TEXT_TERMS =
  /(文字|テキスト|ロゴ|ロゴタイプ|ロゴマーク|ワードマーク|英字|名前|text|lettering|logo|wordmark|watermark|brand)/i
const REMOVE_TERMS =
  /(消|削除|除去|取り除|なく|無く|修復|補修|埋め|隠|remove|delete|erase|without|clean\s*up|heal|inpaint|no\s+)/i

const ADD_TERMS = /(つけ|付け|付与|追加|入れ|加え|載せ|添え|書き|描き|add|put|place|write|insert)/i
const ADD_NEGATION = /(ないで|しないで|せずに|なしで|不要|やめて|don'?t|do\s+not|never)/i
/** 既にある文字へ手を入れる依頼。追加ではないので、確定描画で重ねてはいけない */
const TEXT_RESTYLE_TERMS =
  /(統一|なじ|馴染|整え|調整|バランス|揃え|そろえ|大きく|小さく|太く|細く|色|位置|動かし|寄せ|restyle|harmoni[sz]e|adjust|align|resize|reposition)/i

export function isTextRestyleIntent(intent: string): boolean {
  return TEXT_TERMS.test(intent) && TEXT_RESTYLE_TERMS.test(intent)
}

/** 「ロゴとロゴタイプの間の余白」のような、絵と文字の間隔を変える依頼 */
const GAP_TERMS = /(余白|間隔|スペース|空き|間の|あいだ|gap|spacing|margin)/i

export function isWordmarkGapIntent(intent: string): boolean {
  return TEXT_TERMS.test(intent) && GAP_TERMS.test(intent)
}

export function isRemovalIntent(intent: string): boolean {
  return REMOVE_TERMS.test(intent)
}

/** 「ロゴタイプをつけて」のような、文字・ロゴの追加指示 */
export function isTextAdditionIntent(intent: string): boolean {
  return (
    TEXT_TERMS.test(intent) &&
    ADD_TERMS.test(intent) &&
    !isRemovalIntent(intent) &&
    !ADD_NEGATION.test(intent)
  )
}

export function isTextRemovalIntent(intent: string): boolean {
  return TEXT_TERMS.test(intent) && isRemovalIntent(intent)
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
  /** プランナーが文脈から推定した描画文字列。鉤括弧の明示指定より優先する */
  renderText?: string,
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

  if (renderText || isTextAdditionIntent(intent)) {
    // 追加依頼に「Do not add any text」を付けると自己矛盾し、モデルは英語の禁止文へ従う
    // （実測: ロゴタイプ追加の指示で絵がほぼ変わらなかった）。描画指示へ切り替える
    const quoted = renderText ?? /[「『"“']([^」』"”']{1,40})[」』"”']/.exec(intent)?.[1]
    return [
      'Edit the input image according to this instruction:',
      intent,
      ...(quoted ? [`Add the exact text "${quoted}" as a clean legible wordmark.`] : []),
      ...(hasEditRegion ? ['Edit only the selected region and blend it seamlessly with the surrounding image.'] : []),
      'Preserve the existing symbol, composition, colors, and geometry.',
      'Render the lettering cleanly and legibly, matching the existing style.',
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
