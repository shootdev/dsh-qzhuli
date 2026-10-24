import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseFrame, WsClient } from '../../src/gateway/ws.ts'
import type { InboundMessage } from '../../src/gateway/port.ts'

/** WHATWG WebSocket 的最小 mock：记录实例、发送帧、支持手动触发事件。 */
class MockWebSocket {
  static instances: MockWebSocket[] = []
  static OPEN = 1
  static CLOSED = 3

  readonly url: string
  readonly protocols?: string | string[]
  readyState = 0
  sent: string[] = []
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

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number, reason?: string): void {
    this.readyState = MockWebSocket.CLOSED
    this.emit('close', { code, reason })
  }

  emit(type: string, event: unknown): void {
    for (const handler of this.listeners.get(type) ?? []) handler(event)
  }

  open(): void {
    this.readyState = MockWebSocket.OPEN
    this.emit('open', {})
  }

  receive(text: string): void {
    this.emit('message', { data: text })
  }

  fail(): void {
    this.emit('error', {})
    this.readyState = MockWebSocket.CLOSED
    this.emit('close', {})
  }
}

const mockWebSocketCtor = MockWebSocket as unknown as typeof WebSocket

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function lastInstance(): MockWebSocket {
  const instance = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  if (!instance) throw new Error('no MockWebSocket instance created')
  return instance
}

describe('ws: parseFrame', () => {
  it('裸 "ping" → 回 pong', () => {
    const send = vi.fn()
    expect(parseFrame('ping', send)).toBeUndefined()
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({ type: 'pong' })
  })

  it('{"type":"ping"} / {"type":"heartbeat"} → 回 pong', () => {
    const send = vi.fn()
    expect(parseFrame('{"type":"ping","ts":1}', send)).toBeUndefined()
    expect(parseFrame('{"type":"heartbeat"}', send)).toBeUndefined()
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('inbound_message → 解析出领域对象', () => {
    const send = vi.fn()
    const msg = parseFrame(
      '{"type":"inbound_message","payload":{"msg_id":"m1","conv_id":"c1","sender_cid":"s1","content":"你好","msg_type":1,"ts":1700000000000}}',
      send,
    )
    expect(msg).toEqual<InboundMessage>({
      messageId: 'm1',
      convId: 'c1',
      senderCid: 's1',
      content: '你好',
      msgType: 1,
      ts: 1700000000000,
    })
    expect(send).not.toHaveBeenCalled()
  })

  it('缺 content / conv_id → undefined', () => {
    expect(parseFrame('{"type":"inbound_message","payload":{"conv_id":"c1","content":""}}', () => {})).toBeUndefined()
    expect(parseFrame('{"type":"inbound_message","payload":{"content":"x"}}', () => {})).toBeUndefined()
  })

  it('非 inbound 类型 / 垃圾输入 → undefined', () => {
    expect(parseFrame('{"type":"other"}', () => {})).toBeUndefined()
    expect(parseFrame('not-json', () => {})).toBeUndefined()
    expect(parseFrame('', () => {})).toBeUndefined()
  })
})

describe('ws: WsClient', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
  })

  it('连接成功 → onConnected，并周期性发送心跳', async () => {
    const onConnected = vi.fn()
    const onDisconnected = vi.fn()
    const client = new WsClient(
      { url: 'wss://test.im.qzhuli.com/wss_openclaw?cid=1', heartbeatIntervalMs: 20, WebSocketImpl: mockWebSocketCtor },
      { onMessage: () => {}, onConnected, onDisconnected, onError: () => {} },
    )
    client.start()
    lastInstance().open()
    expect(onConnected).toHaveBeenCalledTimes(1)
    await sleep(30)
    const pings = lastInstance().sent.filter((frame) => JSON.parse(frame).type === 'ping')
    expect(pings.length).toBeGreaterThanOrEqual(1)
    client.stop()
  })

  it('服务端 ping 帧 → 回 pong', () => {
    const client = new WsClient(
      { url: 'wss://x/wss_openclaw', WebSocketImpl: mockWebSocketCtor },
      { onMessage: () => {}, onConnected: () => {}, onDisconnected: () => {}, onError: () => {} },
    )
    client.start()
    const ws = lastInstance()
    ws.open()
    ws.receive('{"type":"ping","ts":1}')
    expect(ws.sent.some((frame) => JSON.parse(frame).type === 'pong')).toBe(true)
    client.stop()
  })

  it('inbound_message → onMessage 回调', () => {
    const onMessage = vi.fn()
    const client = new WsClient(
      { url: 'wss://x/wss_openclaw', WebSocketImpl: mockWebSocketCtor },
      { onMessage, onConnected: () => {}, onDisconnected: () => {}, onError: () => {} },
    )
    client.start()
    const ws = lastInstance()
    ws.open()
    ws.receive('{"type":"inbound_message","payload":{"msg_id":"m1","conv_id":"c1","sender_cid":"s1","content":"hi","msg_type":1}}')
    expect(onMessage).toHaveBeenCalledTimes(1)
    expect(onMessage.mock.calls[0]?.[0]).toMatchObject({ convId: 'c1', content: 'hi', senderCid: 's1' })
    client.stop()
  })

  it('断线 → 指数退避重连（产生新实例）', async () => {
    const client = new WsClient(
      { url: 'wss://x/wss_openclaw', reconnectMinMs: 5, WebSocketImpl: mockWebSocketCtor },
      { onMessage: () => {}, onConnected: () => {}, onDisconnected: () => {}, onError: () => {} },
    )
    client.start()
    lastInstance().open()
    lastInstance().close()
    await sleep(15)
    expect(MockWebSocket.instances.length).toBe(2)
    client.stop()
  })

  it('openClawToken → WS subprotocol', () => {
    const client = new WsClient(
      { url: 'wss://x/wss_openclaw', openClawToken: 'tok1', WebSocketImpl: mockWebSocketCtor },
      { onMessage: () => {}, onConnected: () => {}, onDisconnected: () => {}, onError: () => {} },
    )
    client.start()
    expect(lastInstance().protocols).toEqual(['X-OpenClaw-Token.tok1'])
    client.stop()
  })

  it('stop 后不再重连', async () => {
    const client = new WsClient(
      { url: 'wss://x/wss_openclaw', reconnectMinMs: 5, WebSocketImpl: mockWebSocketCtor },
      { onMessage: () => {}, onConnected: () => {}, onDisconnected: () => {}, onError: () => {} },
    )
    client.start()
    client.stop()
    lastInstance().close()
    await sleep(15)
    expect(MockWebSocket.instances.length).toBe(1)
  })
})
