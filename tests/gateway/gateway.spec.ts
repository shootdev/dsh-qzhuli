import { beforeEach, describe, expect, it, vi } from 'vitest'
import { QzhuliGateway } from '../../src/gateway/gateway.ts'
import type { BoundSession, GatewayStatus, SendResult } from '../../src/gateway/port.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3
  readonly url: string
  readonly protocols?: string | string[]
  readyState = 0
  closed = false
  private listeners = new Map<string, Set<(event: unknown) => void>>()

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    MockWebSocket.instances.push(this)
  }

  addEventListener(type: string, handler: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set()
    set.add(handler)
    this.listeners.set(type, set)
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  send(): void {}

  close(code?: number, reason?: string): void {
    this.closed = true
    this.readyState = MockWebSocket.CLOSED
    for (const handler of this.listeners.get('close') ?? []) handler({ code, reason })
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    for (const handler of this.listeners.get('open') ?? []) handler({})
  }
}

const mockWebSocketCtor = MockWebSocket as unknown as typeof WebSocket

const bound: BoundSession = { convId: 'c1', senderCid: 's1', wsToken: 'tok' }

function statusRecorder(): { statuses: GatewayStatus[]; onStatus: (status: GatewayStatus) => void } {
  const statuses: GatewayStatus[] = []
  return {
    statuses,
    onStatus: (status: GatewayStatus): void => {
      statuses.push(status)
    },
  }
}

describe('gateway: 已绑定直连', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('start 解析凭据 → 连 WS', async () => {
    const recorder = statusRecorder()
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => bound,
      WebSocketImpl: mockWebSocketCtor,
      onStatus: recorder.onStatus,
    })
    await gateway.start()
    const ws = MockWebSocket.instances[0]
    expect(ws).toBeDefined()
    expect(ws?.url).toContain('wss://im.qzhuli.com/wss_openclaw')
    expect(ws?.url).toContain('cid=s1')
    expect(ws?.url).toContain('token=tok')
    expect(ws?.url).toContain('conv_id=c1')
    ws?.open()
    expect(recorder.statuses.some((s) => s.bindStatus === 'bound' && s.connected)).toBe(true)
    await gateway.stop()
  })

  it('openClawToken 进入 WS subprotocol', async () => {
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => bound,
      resolveOpenClawToken: async () => 'tok-x',
      WebSocketImpl: mockWebSocketCtor,
    })
    await gateway.start()
    expect(MockWebSocket.instances[0]?.protocols).toEqual(['X-OpenClaw-Token.tok-x'])
    await gateway.stop()
  })

  it('send → push_message 带 sender_cid 与 role 0', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ code: 200 }) }) as unknown as Response)
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => bound,
      WebSocketImpl: mockWebSocketCtor,
      fetchImpl,
    })
    await gateway.start()
    const result = await gateway.send('c1', '你好')
    expect(result.success).toBe(true)
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://im.qzhuli.com/api/v1/conversations/push_message')
    expect(JSON.parse(String(init.body))).toEqual({
      conv_id: 'c1',
      content: '你好',
      msg_type: 1,
      role: 0,
      sender_cid: 's1',
    })
    await gateway.stop()
  })
})

describe('gateway: 扫码绑定流程', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('无凭据 + bindKey → pending → 绑定成功回调 → 连 WS', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: 1, conversation_id: 'c9', cid: 's9', bind_token: 't9' }),
    }) as unknown as Response)
    const recorder = statusRecorder()
    const onBound = vi.fn()
    const gateway = new QzhuliGateway({
      environment: 'release',
      bindKey: 'bk',
      resolveSession: async () => undefined,
      fetchImpl,
      WebSocketImpl: mockWebSocketCtor,
      onStatus: recorder.onStatus,
    })
    gateway.onBound(onBound)
    await gateway.start()
    await vi.waitFor(() => {
      expect(onBound).toHaveBeenCalledTimes(1)
    })
    expect(onBound.mock.calls[0]?.[0]).toEqual<BoundSession>({ convId: 'c9', senderCid: 's9', wsToken: 't9' })
    await vi.waitFor(() => {
      expect(MockWebSocket.instances.length).toBe(1)
    })
    expect(recorder.statuses.some((s) => s.bindStatus === 'pending')).toBe(true)
    expect(recorder.statuses.some((s) => s.bindStatus === 'bound')).toBe(true)
    await gateway.stop()
  })

  it('绑定超时 → status=timeout', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 0 }) }) as unknown as Response)
    const recorder = statusRecorder()
    const gateway = new QzhuliGateway({
      environment: 'release',
      bindKey: 'bk',
      resolveSession: async () => undefined,
      fetchImpl,
      bindPollIntervalMs: 5,
      bindTimeoutMs: 30,
      WebSocketImpl: mockWebSocketCtor,
      onStatus: recorder.onStatus,
    })
    await gateway.start()
    await vi.waitFor(() => {
      expect(recorder.statuses.some((s) => s.bindStatus === 'timeout')).toBe(true)
    })
    await gateway.stop()
  })

  it('无凭据且无 bindKey → status=error', async () => {
    const recorder = statusRecorder()
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => undefined,
      onStatus: recorder.onStatus,
    })
    await gateway.start()
    expect(recorder.statuses[recorder.statuses.length - 1]?.bindStatus).toBe('error')
  })
})

describe('gateway: 消息流转与停止', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('入站消息 → onInbound 回调', async () => {
    const onInbound = vi.fn()
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => bound,
      WebSocketImpl: mockWebSocketCtor,
    })
    gateway.onInbound(onInbound)
    await gateway.start()
    MockWebSocket.instances[0]?.open()
    MockWebSocket.instances[0]?.emit?.('message', {
      data: '{"type":"inbound_message","payload":{"msg_id":"m1","conv_id":"c1","sender_cid":"s1","content":"hi","msg_type":1}}',
    })
    await sleep(10)
    expect(onInbound).toHaveBeenCalledTimes(1)
    expect(onInbound.mock.calls[0]?.[0]).toMatchObject({ convId: 'c1', content: 'hi' })
    await gateway.stop()
  })

  it('stop → 关闭 WS 且不再重连', async () => {
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => bound,
      reconnectMinMs: 5,
      WebSocketImpl: mockWebSocketCtor,
    })
    await gateway.start()
    const ws = MockWebSocket.instances[0]
    ws?.open()
    await gateway.stop()
    expect(ws?.closed).toBe(true)
    await sleep(15)
    expect(MockWebSocket.instances.length).toBe(1)
  })

  it('push 失败 → send 返回失败结果（不上抛）', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response)
    const gateway = new QzhuliGateway({
      environment: 'release',
      resolveSession: async () => bound,
      fetchImpl,
      WebSocketImpl: mockWebSocketCtor,
    })
    await gateway.start()
    const result: SendResult = await gateway.send('c1', 'x')
    expect(result.success).toBe(false)
    await gateway.stop()
  })
})
