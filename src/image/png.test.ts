import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { imageContentDigest } from './png.js'
import { sha256 } from '../prov/sha256.js'

/**
 * 同じ prompt / model / seed で 2 回出した実物。
 * 画素は完全に一致し、XMP と EXIF の生成時刻だけが違う。
 */
const A = 'data/run/images/8541330f7b4ff028.png'
const B = 'data/run/images/1fa176c26cd900b2.png'

describe('画像の内容ハッシュ', () => {
  it('PNG でないものはファイル全体を数える', () => {
    const bytes = new TextEncoder().encode('not a png')
    expect(imageContentDigest(bytes)).toBe(sha256(bytes))
  })

  it.runIf(existsSync(A) && existsSync(B))(
    '時刻メタデータだけが違う 2 枚は、同じ内容として扱う',
    () => {
      const a = new Uint8Array(readFileSync(A))
      const b = new Uint8Array(readFileSync(B))
      // ファイル全体では食い違う
      expect(sha256(a)).not.toBe(sha256(b))
      // 内容としては同じ
      expect(imageContentDigest(a)).toBe(imageContentDigest(b))
    },
  )
})
