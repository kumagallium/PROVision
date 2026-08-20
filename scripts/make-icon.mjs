/**
 * アプリのアイコンを生成する。
 *
 * 系譜のグリフ——1 つの点から枝分かれして 4 つになる形。
 * 外部の画像編集に頼らず、リポジトリの中だけで作り直せるようにしておく。
 *
 *   node scripts/make-icon.mjs        # src-tauri/app-icon.png を書く
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const S = 1024
const BG = [26, 42, 56]      // 濃紺
const NODE = [235, 241, 247] // ほぼ白
const EDGE = [91, 143, 185]  // 青

const px = new Uint8Array(S * S * 4)
for (let i = 0; i < S * S; i++) {
  px[i * 4] = BG[0]
  px[i * 4 + 1] = BG[1]
  px[i * 4 + 2] = BG[2]
  px[i * 4 + 3] = 255
}

const put = (x, y, c, a = 1) => {
  if (x < 0 || y < 0 || x >= S || y >= S) return
  const i = (y * S + x) * 4
  for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - a) + c[k] * a)
}

const disc = (cx, cy, r, c) => {
  for (let y = Math.floor(cy - r - 2); y <= cy + r + 2; y++) {
    for (let x = Math.floor(cx - r - 2); x <= cx + r + 2; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r + 1) put(x, y, c, Math.min(1, r + 1 - d))
    }
  }
}

const line = (x0, y0, x1, y1, w, c) => {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w, c)
  }
}

// 上から下へ 1 → 1 → 2 の系譜
const root = [512, 210]
const mid = [512, 470]
const left = [300, 760]
const right = [724, 760]

line(...root, ...mid, 14, EDGE)
line(...mid, ...left, 14, EDGE)
line(...mid, ...right, 14, EDGE)
for (const [x, y] of [root, mid, left, right]) disc(x, y, 62, NODE)

// PNG に詰める
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1)
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crcTable = chunk.table ?? (chunk.table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  }))
  let crc = 0xffffffff
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8)
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
  return Buffer.concat([len, body, crcBuf])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
])
writeFileSync('src-tauri/app-icon.png', png)
console.log('src-tauri/app-icon.png を書いた')
