/**
 * 领域层端口：Q助理网关对外（适配层）的最小契约。
 * 本目录（src/gateway）零 DeepSeek Harness 依赖 —— 只依赖 Node 标准库与全局 fetch/WebSocket。
 */

/** imnut `inbound_message` 帧解析后的领域对象。 */
export interface InboundMessage {
  /** 服务端消息 id（可用于日志/幂等）。 */
  readonly messageId: string
  /** 会话 id。 */
  readonly convId: string
  /** 发送者 cid（绑定会话中即绑定用户的 cid，不要当作“自己回显”过滤）。 */
  readonly senderCid: string
  /** 文本内容。 */
  readonly content: string
  /** imnut msg_type；1 = 文本（LobsterAI 实测值）。 */
  readonly msgType: number
  /** 服务端时间戳（毫秒）。 */
  readonly ts?: number
}

/** 出站消息发送结果。 */
export interface SendResult {
  readonly success: boolean
  readonly error?: string
  readonly messageId?: string
}

/** 绑定状态。 */
export type BindStatus = 'unbound' | 'pending' | 'bound' | 'timeout' | 'error'

/** 扫码绑定成功后的会话凭据。 */
export interface BoundSession {
  readonly convId: string
  readonly senderCid: string
  readonly wsToken: string
}

/** 网关状态快照（供日志与状态展示）。 */
export interface GatewayStatus {
  readonly bindStatus: BindStatus
  readonly connected: boolean
  readonly error?: string
}

/** Q助理网关通道：协议层实现，适配层消费。 */
export interface QzhuliChannel {
  /** 启动通道：已绑定 → 直连 WS；仅持有 bindKey → 后台扫码绑定轮询。 */
  start(): Promise<void>
  /** 停止通道：关闭 WS、取消绑定轮询。 */
  stop(): Promise<void>
  /** 注册入站消息处理器（最后一次调用生效）。 */
  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void
  /** 绑定成功回调（适配层据此持久化凭据，重启后免扫码）。 */
  onBound?(handler: (session: BoundSession) => void): void
  /** 向指定会话推送一条文本消息（role=0 Assistant）。 */
  send(convId: string, text: string): Promise<SendResult>
}
