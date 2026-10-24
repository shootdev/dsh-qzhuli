/**
 * wss_openclaw 客户端：收消息、心跳、断线指数退避重连。
 * 基于 Node 全局 WebSocket（WHATWG 实现），零第三方依赖。
 */

import { PROTOCOL, heartbeatFrame, pongFrame } from './protocol.ts'
import type { InboundMessage } from './port.ts'

export interface WsClientOptions {
  readonly url: string
  /** 可选 Sec-WebSocket-Protocol：X-OpenClaw-Token.<value>。 */
  readonly openClawToken?: string
  readonly heartbeatIntervalMs?: number
  readonly reconnectMinMs?: number
  readonly reconnectMaxMs?: number
  /** 半开检测：心跳间隔倍数，超过该倍数未收到任何服务端帧则强制重连。 */
  readonly staleHeartbeatMultiplier?: number
  /** 可注入 WebSocket 实现（测试用）。 */
  readonly WebSocketImpl?: typeof WebSocket
}

export interface WsClientEvents {
  onMessage(msg: InboundMessage): void
  onConnected(): void
  onDisconnected(): void
  onError(error: string): void
}

const WS_OPEN = 1

interface FramePayload {
  readonly msg_id?: unknown
  readonly conv_id?: unknown
  readonly sender_cid?: unknown
  readonly content?: unknown
  readonly msg_type?: unknown
  readonly ts?: unknown
}

/**
 * 解析一帧文本。
 * - 服务端 `ping` 或 `{"type":"ping"}` → 应答 pong，返回 undefined
 * - `inbound_message` → 解析为 InboundMessage
 * - 其余 → undefined
 */
export function parseFrame(text: string, send: (frame: string) => void): InboundMessage | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (trimmed.toLowerCase() === 'ping') {
    send(pongFrame())
    return undefined
  }
  let frame: unknown
  try {
    frame = JSON.parse(trimmed) as unknown
  } catch {
    return undefined
  }
  if (typeof frame !== 'object' || frame === null) return undefined
  const record = frame as Record<string, unknown>
  const type = String(record.type ?? '').toLowerCase()
  if (type === 'ping' || type === 'heartbeat') {
    send(pongFrame())
    return undefined
  }
  if (type !== 'inbound_message') return undefined
  const payload = record.payload as FramePayload | undefined
  if (typeof payload !== 'object' || payload === null) return undefined
  const convId = String(payload.conv_id ?? '').trim()
  const content = String(payload.content ?? '').trim()
  if (!convId || !content) return undefined
  const rawId = payload.msg_id
  const messageId = rawId === undefined || rawId === null ? String(Date.now()) : String(rawId)
  const rawTs = payload.ts
  return {
    messageId,
    convId,
    senderCid: String(payload.sender_cid ?? '').trim(),
    content,
    msgType: typeof payload.msg_type === 'number' ? payload.msg_type : Number(payload.msg_type ?? 1),
    ...(rawTs === undefined ? {} : { ts: Number(rawTs) }),
  }
}

export class WsClient {
  private readonly options: WsClientOptions
  private readonly events: WsClientEvents
  private readonly WebSocketImpl: typeof WebSocket
  private ws: WebSocket | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private reconnectDelay: number
  private closed = false
  /** 最近一次收到服务端帧的时间（半开检测基准）。 */
  private lastActivityAt = 0

  constructor(options: WsClientOptions, events: WsClientEvents) {
    this.options = options
    this.events = events
    this.WebSocketImpl = options.WebSocketImpl ?? WebSocket
    this.reconnectDelay = options.reconnectMinMs ?? PROTOCOL.reconnectMinMs
  }

  start(): void {
    this.closed = false
    this.connect()
  }

  stop(): void {
    this.closed = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.stopHeartbeat()
    const ws = this.ws
    this.ws = undefined
    if (ws && ws.readyState === WS_OPEN) {
      try {
        ws.close(1000, 'plugin stop')
      } catch {
        // 忽略关闭异常
      }
    }
  }

  private connect(): void {
    if (this.closed) return
    const token = this.options.openClawToken?.trim()
    const protocols = token ? [`X-OpenClaw-Token.${token}`] : undefined
    let ws: WebSocket
    try {
      ws = protocols
        ? new this.WebSocketImpl(this.options.url, protocols)
        : new this.WebSocketImpl(this.options.url)
    } catch (error) {
      this.events.onError(String(error))
      this.scheduleReconnect()
      return
    }
    this.ws = ws
    ws.addEventListener('open', () => {
      this.reconnectDelay = this.options.reconnectMinMs ?? PROTOCOL.reconnectMinMs
      this.lastActivityAt = Date.now()
      this.events.onConnected()
      this.startHeartbeat()
    })
    ws.addEventListener('message', (event: MessageEvent) => {
      this.lastActivityAt = Date.now()
      void this.handleData(event.data)
    })
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.ws = undefined
      this.stopHeartbeat()
      this.events.onDisconnected()
      this.scheduleReconnect()
    })
    ws.addEventListener('error', () => {
      this.events.onError('websocket error')
      // close 事件随后触发重连
    })
  }

  private async handleData(data: unknown): Promise<void> {
    try {
      let text: string
      if (typeof data === 'string') {
        text = data
      } else if (data instanceof Blob) {
        text = await data.text()
      } else if (data instanceof ArrayBuffer) {
        text = new TextDecoder().decode(data)
      } else {
        text = String(data)
      }
      const ws = this.ws
      const send = (frame: string): void => {
        if (ws && ws.readyState === WS_OPEN) ws.send(frame)
      }
      const msg = parseFrame(text, send)
      if (msg) this.events.onMessage(msg)
    } catch (error) {
      this.events.onError(String(error))
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.options.heartbeatIntervalMs ?? PROTOCOL.heartbeatIntervalMs
    this.heartbeatTimer = setInterval(() => {
      const ws = this.ws
      if (!ws || ws.readyState !== WS_OPEN) return
      const staleAfter = (this.options.staleHeartbeatMultiplier ?? PROTOCOL.staleHeartbeatMultiplier) * interval
      if (this.lastActivityAt > 0 && Date.now() - this.lastActivityAt > staleAfter) {
        // 半开连接：服务端超过 staleAfter 未回任何帧（心跳无应答），
        // 强制断开以触发 close → 指数退避重连；否则消息会永远静默丢失。
        this.stopHeartbeat()
        try {
          ws.close(4001, 'stale connection: no frames')
        } catch {
          // 关闭异常忽略，close 事件仍会触发重连
        }
        return
      }
      try {
        ws.send(heartbeatFrame())
      } catch {
        // 发送失败说明底层连接已不可用，断开触发重连
        this.stopHeartbeat()
        try {
          ws.close(4001, 'heartbeat send failed')
        } catch {
          // 关闭异常忽略，close 事件仍会触发重连
        }
      }
    }, interval)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMaxMs ?? PROTOCOL.reconnectMaxMs)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      this.connect()
    }, delay)
  }
}
