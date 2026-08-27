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
 * その編集が**絵の一部を直すのか、全体を作り替えるのか**（D-023）。
 *
 * - `local`: 余白・色・文字など、一部を直す。他は保つ
 * - `whole`: 抽象化・フラット化・様式の変更など、**全体を作り替える**
 */
export type EditScope = 'local' | 'whole'

/**
 * 全体を作り替える依頼か。**規則で当てにいくのは、LLM が答えなかったときだけ**。
 * 判断そのものは指示を読んだ側（プランナー）がやるほうが確かである。
 */
const WHOLE_IMAGE_TERMS =
  /(抽象化|抽象的|シンプル|簡素|簡略|フラット|ベタ|平面|線画|絵柄|画風|様式|テイスト|イラスト調|ミニマル|作り直|描き直|書き直|大胆|全面的|全体的|simplif|abstract|flat|minimal|solid\s+(colou?r|illustration)|line\s*art|redesign|redraw|rework|restyle|bolder)/i

export function isWholeImageIntent(intent: string): boolean {
  return WHOLE_IMAGE_TERMS.test(intent)
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
  /** 一部を直すのか、全体を作り替えるのか（D-023） */
  scope: EditScope = 'local',
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
      scope === 'whole'
        ? 'Redraw the artwork in the requested style; it is expected to look different from the input.'
        : 'Preserve the existing symbol, composition, colors, and geometry.',
      'Render the lettering cleanly and legibly, matching the existing style.',
    ].join(' ')
  }

  /**
   * **保存を求める文を、作り替えの依頼へ付けてはいけない**（D-023）。
   * 「シンプルにして」の直後に「既存の要素・構図・色・形をすべて保て」と書くと
   * 自己矛盾し、モデルは保存の方に従う（実測: 絵がほとんど変わらなかった）。
   * 文字追加へ「Do not add any text」を付けたときと同じ失敗である。
   */
  return [
    'Edit the input image according to this instruction:',
    intent,
    ...(hasEditRegion ? ['Edit only the selected region and blend it seamlessly with the surrounding image.'] : []),
    ...(scope === 'whole'
      ? [
          'Redraw the whole image in the requested style. It is expected to look clearly different from the input.',
          'Keep the subject and what it depicts, but the composition, level of detail, and rendering style may change.',
        ]
      : [
          'Preserve all existing visual elements, composition, colors, and geometry unless explicitly changed.',
        ]),
    'Do not add any text, logo, brand name, or watermark unless explicitly requested.',
  ].join(' ')
}
