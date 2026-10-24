import { describe, expect, it } from 'vitest'
import {
  checkBindStatusUrl,
  heartbeatFrame,
  pongFrame,
  pushMessageUrl,
  resolveEnvironment,
  wssOpenclawUrl,
} from '../../src/gateway/protocol.ts'

describe('protocol: 环境与 URL', () => {
  it('resolveEnvironment 归一化', () => {
    expect(resolveEnvironment(undefined)).toBe('release')
    expect(resolveEnvironment(null)).toBe('release')
    expect(resolveEnvironment('dev')).toBe('dev')
    expect(resolveEnvironment('DEV')).toBe('dev')
    expect(resolveEnvironment(' release ')).toBe('release')
    expect(resolveEnvironment('x')).toBe('release')
  })

  it('checkBindStatusUrl 指向生产 client 域并带绑定密钥', () => {
    const url = checkBindStatusUrl('release', 'k&1')
    expect(url).toBe('https://client.qzhuli.com/aimachine/check_bind_status?bind_key=k%261')
  })

  it('wssOpenclawUrl 指向测试 IM 域并带全部参数', () => {
    const url = wssOpenclawUrl('dev', { cid: 'cid-1', token: 'tok', convId: '9boGaR7' })
    expect(url).toBe('wss://test.im.qzhuli.com/wss_openclaw?cid=cid-1&token=tok&conv_id=9boGaR7')
  })

  it('pushMessageUrl 指向 IM 域发消息接口', () => {
    expect(pushMessageUrl('release')).toBe('https://im.qzhuli.com/api/v1/conversations/push_message')
  })
})

describe('protocol: 心跳帧', () => {
  it('心跳为 {"type":"ping","ts":...}', () => {
    expect(JSON.parse(heartbeatFrame(1))).toEqual({ type: 'ping', ts: 1 })
  })

  it('pong 为 {"type":"pong","ts":...}', () => {
    expect(JSON.parse(pongFrame(2))).toEqual({ type: 'pong', ts: 2 })
  })
})
