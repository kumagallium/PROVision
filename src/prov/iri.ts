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

export function agentIri(base: string, slug: string): string {
  return `${base}/agent/${slug}`
}
