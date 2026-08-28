import { describe, expect, it } from 'vitest'
import { isProvisionHealth, portFromSidecarLog } from './api-base.js'

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

describe('割り当てられたポートの聞き取り（D-024）', () => {
  it('サーバが出す行から番号を読む', () => {
    // 実測でそのまま出た行。OS に選ばせたので 8788 ではない
    expect(
      portFromSidecarLog(
        '[stdout] PROVision server: http://127.0.0.1:60464  data=/Users/x/Documents/PROVision',
      ),
    ).toBe(60464)
    expect(portFromSidecarLog('PROVision server: http://127.0.0.1:8788  data=/tmp/d')).toBe(8788)
  })

  it('関係ない行からは読まない', () => {
    expect(portFromSidecarLog('[sidecar] pid=123 port=0 で起動しました')).toBeUndefined()
    expect(portFromSidecarLog('[stderr] something went wrong')).toBeUndefined()
    expect(portFromSidecarLog('')).toBeUndefined()
  })
})
