/**
 * imnut 协议常量、URL 构造与心跳帧。
 * 全部数值来自 Hermes-Agent plugins/qzhuli 的实测实现（LobsterAI）。
 */

/** Q助理环境：release = 生产，dev = 测试。 */
export type QzhuliEnvironment = 'release' | 'dev'

/** Q助理域名表。 */
export const QZHULI_CLIENT_HOST: Record<QzhuliEnvironment, string> = {
  release: 'client.qzhuli.com',
  dev: 'test.client.qzhuli.com',
}

export const QZHULI_IM_HOST: Record<QzhuliEnvironment, string> = {
  release: 'im.qzhuli.com',
  dev: 'test.im.qzhuli.com',
}

export const PROTOCOL = {
  scheme: 'https',
  wsScheme: 'wss',
  /** 扫码绑定状态轮询接口。 */
  checkBindPath: '/aimachine/check_bind_status',
  /** 收消息 WebSocket。 */
  wsPath: '/wss_openclaw',
  /** 发消息 HTTP 接口。 */
  pushPath: '/api/v1/conversations/push_message',
  /** 绑定轮询间隔。 */
  bindPollIntervalMs: 5_000,
  /** 绑定超时：10 分钟未在手机端确认即放弃。 */
  bindTimeoutMs: 600_000,
  /** push_message 超时。 */
  pushTimeoutMs: 30_000,
  /** WS 断线重连指数退避区间（2s → 30s）。 */
  reconnectMinMs: 2_000,
  reconnectMaxMs: 30_000,
  /** 心跳间隔。 */
  heartbeatIntervalMs: 30_000,
} as const

/** 归一化环境名；未知值回落 release。 */
export function resolveEnvironment(value: string | undefined | null): QzhuliEnvironment {
  const raw = (value ?? 'release').trim().toLowerCase()
  return raw === 'dev' ? 'dev' : 'release'
}

/** 扫码绑定状态轮询 URL。 */
export function checkBindStatusUrl(environment: QzhuliEnvironment, bindKey: string): string {
  return `${PROTOCOL.scheme}://${QZHULI_CLIENT_HOST[environment]}${PROTOCOL.checkBindPath}?bind_key=${encodeURIComponent(bindKey)}`
}

/** WS 连接参数。 */
export interface WsSessionParams {
  readonly cid: string
  readonly token: string
  readonly convId: string
}

/** 收消息 WebSocket URL。 */
export function wssOpenclawUrl(environment: QzhuliEnvironment, params: WsSessionParams): string {
  const qs = new URLSearchParams({ cid: params.cid, token: params.token, conv_id: params.convId })
  return `${PROTOCOL.wsScheme}://${QZHULI_IM_HOST[environment]}${PROTOCOL.wsPath}?${qs}`
}

/** 发消息 HTTP URL。 */
export function pushMessageUrl(environment: QzhuliEnvironment): string {
  return `${PROTOCOL.scheme}://${QZHULI_IM_HOST[environment]}${PROTOCOL.pushPath}`
}

/** 客户端心跳帧（每 30s 发送）。 */
export function heartbeatFrame(nowMs = Date.now()): string {
  return JSON.stringify({ type: 'ping', ts: nowMs })
}

/** 收到服务端 ping / heartbeat 后的应答帧。 */
export function pongFrame(nowMs = Date.now()): string {
  return JSON.stringify({ type: 'pong', ts: nowMs })
}
