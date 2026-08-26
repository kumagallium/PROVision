/**
 * 外から持ち込んだ画像を取り込む（D-019）。
 *
 * **PNG はそのまま通す。** 再エンコードすると走査線フィルタの選び方が変わり、
 * 画素が同じでも内容ハッシュ（D-010）が変わる。触らない方が「同じ絵は同じ Entity へ
 * 収束する」（D-001）に忠実である。
 *
 * PNG 以外だけ Jimp で PNG へ直す。**直したときだけ Jimp が走った**ので、
 * SoftwareAgent もそのときだけ付ける——実際に走ったものだけを記録に残す（D-015）。
 *
 * 形式は**中身のマジックバイトで決める**。data URL のヘッダもファイル名の拡張子も
 * 画面から来た名乗りにすぎず、中身と食い違いうる。
 */
import { Jimp } from 'jimp'
import { sha256 } from '../prov/sha256.js'

/** 取り込める上限。実験画像の TIFF は大きい */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024

interface Signature {
  mediaType: string
  magic: readonly number[]
}

/** Jimp が読める形式だけ並べる。ここに無いものは取り込まない */
const SIGNATURES: readonly Signature[] = [
  { mediaType: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mediaType: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
  { mediaType: 'image/gif', magic: [0x47, 0x49, 0x46, 0x38] },
  { mediaType: 'image/bmp', magic: [0x42, 0x4d] },
  // TIFF はバイト順で 2 通りある
  { mediaType: 'image/tiff', magic: [0x49, 0x49, 0x2a, 0x00] },
  { mediaType: 'image/tiff', magic: [0x4d, 0x4d, 0x00, 0x2a] },
]

/** 中身から形式を決める。分からなければ undefined（推測しない） */
export function detectMediaType(bytes: Uint8Array): string | undefined {
  return SIGNATURES.find((s) => s.magic.every((b, i) => bytes[i] === b))?.mediaType
}

export interface ImportedImage {
  /** 取り込んだ結果。ここから先は PNG だけを扱う */
  png: Uint8Array
  /**
   * **元ファイルのバイト列そのもの**のハッシュ。Entity の同一性（画素ハッシュ、D-010）
   * とは別に持つ。これが無いと、手元の生ファイルと図版の出発点を結びつけられない
   */
  sourceFileDigest: string
  /** 中身から判定した形式。名乗りは使わない */
  sourceFileMediaType: string
  /** PNG へ直したか。直したときだけ Jimp が走っている */
  converted: boolean
}

export async function importImage(bytes: Uint8Array): Promise<ImportedImage> {
  if (bytes.length === 0) throw new Error('取り込む画像が空です')
  if (bytes.length > MAX_IMPORT_BYTES) {
    throw new Error(
      `取り込める画像は ${Math.floor(MAX_IMPORT_BYTES / 1024 / 1024)}MB までです`,
    )
  }
  const sourceFileMediaType = detectMediaType(bytes)
  if (!sourceFileMediaType) {
    throw new Error('PNG / JPEG / GIF / BMP / TIFF のいずれかを取り込んでください')
  }
  const sourceFileDigest = sha256(bytes)

  if (sourceFileMediaType === 'image/png') {
    return { png: bytes, sourceFileDigest, sourceFileMediaType, converted: false }
  }

  const image = await Jimp.read(Buffer.from(bytes))
  const png = new Uint8Array(await image.getBuffer('image/png'))
  return { png, sourceFileDigest, sourceFileMediaType, converted: true }
}

/**
 * 書き出すファイル名。**パスは載せない**（D-017 と同じ理由）。
 * 利用者名がファイルへ載るうえ、同じファイルを別の場所から取り込んだ 2 台を
 * 突き合わせられなくなる。
 */
export function baseFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  // 制御文字だけ落とす。空白やハイフンは名前の一部なので残す
  return base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120)
}
