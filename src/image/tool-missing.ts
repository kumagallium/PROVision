/**
 * 手元にその道具が無い、というエラー（D-029）。**設定不足であって故障ではない。**
 *
 * `code` を持たせるのは、画面が**文言ではなく印で**導入へ誘導するためである。
 * 文言の一致で判定すると、文言を直した瞬間に誘導が消える。
 */
export class ToolMissingError extends Error {
  readonly code = 'image-command-missing' as const

  constructor(message: string) {
    super(message)
    this.name = 'ToolMissingError'
  }
}
