import { describe, expect, it, vi } from 'vitest'
import { BindService, parseBoundPayload } from '../../src/gateway/bind.ts'

function jsonFetch(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
}

describe('bind: parseBoundPayload', () => {
  it('status=1 且字段齐全 → 凭据', () => {
    const result = parseBoundPayload({ status: 1, conversation_id: 'c1', cid: 'cid1', bind_token: 'tok' })
    expect(result).toEqual({ convId: 'c1', senderCid: 'cid1', wsToken: 'tok' })
  })

  it('status="bound" 且走 data 嵌套 → 凭据', () => {
    const result = parseBoundPayload({ data: { status: 'bound', conv_id: 'c2', cid: 'cid2', token: 't2' } })
    expect(result).toEqual({ convId: 'c2', senderCid: 'cid2', wsToken: 't2' })
  })

  it('status 未就绪 → undefined', () => {
    expect(parseBoundPayload({ status: 0 })).toBeUndefined()
    expect(parseBoundPayload({ status: 'pending' })).toBeUndefined()
  })

  it('字段不全 → undefined', () => {
    expect(parseBoundPayload({ status: 1, conversation_id: 'c1' })).toBeUndefined()
    expect(parseBoundPayload({ status: 1, conversation_id: 'c1', cid: 'x' })).toBeUndefined()
  })

  it('非对象 → undefined', () => {
    expect(parseBoundPayload('x')).toBeUndefined()
    expect(parseBoundPayload(null)).toBeUndefined()
  })
})

describe('bind: BindService', () => {
  it('pollOnce 返回凭据', async () => {
    const fetchImpl = jsonFetch({ status: 1, conversation_id: 'c1', cid: 'cid1', bind_token: 'tok' })
    const service = new BindService({ environment: 'release', bindKey: 'k', fetchImpl })
    await expect(service.pollOnce()).resolves.toEqual({ convId: 'c1', senderCid: 'cid1', wsToken: 'tok' })
  })

  it('run 绑定成功后回调并返回 bound', async () => {
    const fetchImpl = jsonFetch({ status: 1, conversation_id: 'c1', cid: 'cid1', bind_token: 'tok' })
    const service = new BindService({ environment: 'release', bindKey: 'k', fetchImpl })
    const onBound = vi.fn()
    await expect(service.run(onBound)).resolves.toBe('bound')
    expect(onBound).toHaveBeenCalledTimes(1)
    expect(onBound.mock.calls[0]?.[0]).toMatchObject({ convId: 'c1' })
  })

  it('run 一直未就绪 → 超时返回 timeout', async () => {
    const fetchImpl = jsonFetch({ status: 0 })
    const service = new BindService({
      environment: 'release',
      bindKey: 'k',
      fetchImpl,
      pollIntervalMs: 5,
      timeoutMs: 25,
    })
    await expect(service.run(() => {})).resolves.toBe('timeout')
  })

  it('cancel 后 run 返回 cancelled', async () => {
    const fetchImpl = jsonFetch({ status: 0 })
    const service = new BindService({
      environment: 'release',
      bindKey: 'k',
      fetchImpl,
      pollIntervalMs: 1_000,
      timeoutMs: 60_000,
    })
    const pending = service.run(() => {})
    service.cancel()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('绑定接口 HTTP 错误不中断轮询，最终超时', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response)
    const service = new BindService({
      environment: 'release',
      bindKey: 'k',
      fetchImpl,
      pollIntervalMs: 5,
      timeoutMs: 25,
    })
    await expect(service.run(() => {})).resolves.toBe('timeout')
  })
})
