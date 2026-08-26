/**
 * IRI の採番。
 *
 * 画像は内容ハッシュ、Activity は「再実行に要る情報＋開始時刻」のハッシュから決める。
 * どちらも決定論的なので、同じ入力からは同じグラフが出る（テストが書ける）。
 */
export { sha256 } from './sha256.js'
import { sha256 } from './sha256.js'

export const DEFAULT_BASE = 'https://kumagallium.github.io/provision/resource'

export function imageIri(base: string, digest: string): string {
  return `${base}/image/${digest}`
}

export function activityIri(base: string, key: string): string {
  return `${base}/activity/${sha256(key).slice(0, 32)}`
}

/** 1 回の送信（`prov:Plan`）。指示そのものと出した時刻から決める */
export function planIri(base: string, key: string): string {
  return `${base}/plan/${sha256(key).slice(0, 32)}`
}

export function agentIri(base: string, slug: string): string {
  return `${base}/agent/${slug}`
}

export function assertionIri(base: string, key: string): string {
  return `${base}/assertion/${sha256(key).slice(0, 32)}`
}

/**
 * 掲載された図版の IRI。**載った先の識別子から作る**（こちらで採番しない）。
 * 同じ論文の同じ図なら、誰が記録しても同じ IRI に収束する。
 */
export function figureIri(partOf: string, label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return `${partOf.replace(/#.*$/, '')}#${slug || 'figure'}`
}
