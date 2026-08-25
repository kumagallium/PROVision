/**
 * 画像の「内容」のハッシュ。
 *
 * **PNG のファイル全体を数えてはいけない。** mflux が書き込む XMP（iTXt）と EXIF に
 * 生成時刻が入るので、まったく同じ絵でもファイルのバイト列は毎回変わる。
 * 内容ハッシュが Entity の IRI を決める（D-001）以上、これを見落とすと
 * 「同じ内容は同じ Entity に収束する」が実質破れる。
 *
 * 実測（2026-08-20）: 同じ prompt / model / seed で 2 回出したところ、
 * 画素は 3,146,752 バイトすべて一致し、違ったのは iTXt と eXIf だけだった。
 *
 * そこで **IHDR（寸法・ビット深度）＋ 展開した IDAT（画素そのもの）** だけを数える。
 * 圧縮の仕方が変わっても、絵が同じなら同じ値になる。
 */
import { inflateSync } from 'node:zlib'
import { sha256 } from '../prov/sha256.js'

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function isPng(bytes: Uint8Array): boolean {
  return PNG_MAGIC.every((b, i) => bytes[i] === b)
}

/**
 * 絵の内容だけを見たハッシュ。PNG でなければファイル全体を数える
 * （他の形式に広げるときは、そこでも同じ考え方で正規化する）。
 */
export function imageContentDigest(bytes: Uint8Array): string {
  if (!isPng(bytes)) return sha256(bytes)

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let header: Uint8Array | null = null
  const idat: Uint8Array[] = []

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset, false)
    const type = String.fromCharCode(
      bytes[offset + 4]!,
      bytes[offset + 5]!,
      bytes[offset + 6]!,
      bytes[offset + 7]!,
    )
    const start = offset + 8
    const end = start + length
    if (end > bytes.length) break

    if (type === 'IHDR') header = bytes.subarray(start, end)
    else if (type === 'IDAT') idat.push(bytes.subarray(start, end))
    else if (type === 'IEND') break

    offset = end + 4 // CRC を飛ばす
  }

  if (!header || idat.length === 0) return sha256(bytes)

  const compressed = Buffer.concat(idat.map((c) => Buffer.from(c)))
  let pixels: Buffer
  try {
    pixels = inflateSync(compressed)
  } catch {
    // 展開できないなら、少なくとも時刻メタデータは外した形で数える
    pixels = compressed
  }

  const seed = Buffer.concat([Buffer.from(header), pixels])
  return sha256(new Uint8Array(seed))
}

export function pngDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  if (!isPng(bytes) || bytes.length < 24) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = view.getUint32(16, false)
  const height = view.getUint32(20, false)
  return width > 0 && height > 0 ? { width, height } : undefined
}
