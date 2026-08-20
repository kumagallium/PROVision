import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { sha256 } from './sha256.js'

describe('SHA-256', () => {
  it('既知のテストベクタと一致する', () => {
    expect(sha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    )
    // 55/56/64 バイト境界はパディングの境目。ここを外すと実装が壊れる
    expect(sha256('a'.repeat(55))).toBe(createHash('sha256').update('a'.repeat(55)).digest('hex'))
    expect(sha256('a'.repeat(56))).toBe(createHash('sha256').update('a'.repeat(56)).digest('hex'))
    expect(sha256('a'.repeat(64))).toBe(createHash('sha256').update('a'.repeat(64)).digest('hex'))
  })

  it('node:crypto と一致する（バイト列・日本語・大きめの入力）', () => {
    const cases: (Uint8Array | string)[] = [
      new Uint8Array([0, 1, 2, 255, 128]),
      '概念図 v1 — 余白を広げた案',
      'x'.repeat(100_000),
    ]
    for (const input of cases) {
      expect(sha256(input)).toBe(createHash('sha256').update(input).digest('hex'))
    }
  })
})
