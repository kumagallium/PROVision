import { describe, expect, it } from 'vitest'
import { isProvisionHealth } from './api-base.js'

describe('ローカルサーバの見分け（D-024）', () => {
  it('印のある応答だけを自分のサーバと認める', () => {
    expect(isProvisionHealth({ ok: true, app: 'provision', version: '0.2.15' })).toBe(true)
  })

  it('200 が返っただけでは自分のサーバと決めない', () => {
    // これが起きたこと: 別のアプリが同じポートで画面 HTML を 200 で返し、
    // それを JSON として読もうとして起動できなかった
    expect(isProvisionHealth({ ok: true })).toBe(false)
    expect(isProvisionHealth({ app: 'asterism' })).toBe(false)
    expect(isProvisionHealth('<!doctype html>')).toBe(false)
    expect(isProvisionHealth(null)).toBe(false)
    expect(isProvisionHealth(undefined)).toBe(false)
  })
})
