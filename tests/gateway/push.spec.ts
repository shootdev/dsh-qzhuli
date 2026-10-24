import { describe, expect, it, vi } from 'vitest'
import { pushMessage } from '../../src/gateway/push.ts'

function jsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
}

describe('push: pushMessage', () => {
  it('code=200 → 成功，且请求体正确', async () => {
    const fetchImpl = jsonFetch({ code: 200 })
    const result = await pushMessage({
      environment: 'release',
      convId: 'c1',
      content: '回复',
      senderCid: 'cid1',
      fetchImpl,
    })
    expect(result.success).toBe(true)
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://im.qzhuli.com/api/v1/conversations/push_message')
    expect(JSON.parse(String(init.body))).toEqual({
      conv_id: 'c1',
      content: '回复',
      msg_type: 1,
      role: 0,
      sender_cid: 'cid1',
    })
  })

  it('role=1 且无 senderCid → 请求体按配置', async () => {
    const fetchImpl = jsonFetch({ code: 200 })
    await pushMessage({ environment: 'dev', convId: 'c2', content: 'x', role: 1, fetchImpl })
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://test.im.qzhuli.com/api/v1/conversations/push_message')
    expect(JSON.parse(String(init.body))).toEqual({ conv_id: 'c2', content: 'x', msg_type: 1, role: 1 })
  })

  it('code≠200 → 失败并带错误信息', async () => {
    const fetchImpl = jsonFetch({ code: 500, msg: 'internal' })
    const result = await pushMessage({ environment: 'release', convId: 'c1', content: 'x', fetchImpl })
    expect(result.success).toBe(false)
    expect(result.error).toContain('internal')
  })

  it('HTTP 非 2xx → 失败', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response)
    const result = await pushMessage({ environment: 'release', convId: 'c1', content: 'x', fetchImpl })
    expect(result).toMatchObject({ success: false, error: 'push http 500' })
  })

  it('fetch 抛错 → 失败（不上抛）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down')
    }) as unknown as typeof fetch
    const result = await pushMessage({ environment: 'release', convId: 'c1', content: 'x', fetchImpl })
    expect(result.success).toBe(false)
    expect(result.error).toContain('network down')
  })
})
