/**
 * QzhuliGateway：组合 扫码绑定轮询 + WS 收消息 + HTTP 推送，实现 QzhuliChannel。
 * 本类不感知 Harness：一切与宿主交互的能力都收敛在构造参数（回调/注入）里。
 */

import { BindService } from './bind.ts'
import type { BindRunResult } from './bind.ts'
import { wssOpenclawUrl } from './protocol.ts'
import { pushMessage } from './push.ts'
import { WsClient } from './ws.ts'
import type { WsClientOptions } from './ws.ts'
import type {
  BindStatus,
  BoundSession,
  GatewayStatus,
  InboundMessage,
  QzhuliChannel,
  SendResult,
} from './port.ts'

export interface QzhuliGatewayOptions {
  readonly environment: 'release' | 'dev'
  /** 无已绑定凭据时的绑定密钥（触发扫码绑定轮询）。 */
  readonly bindKey?: string
  /** 每次（重）连接前调用，解析已绑定凭据（支持凭据热更新）。 */
  readonly resolveSession?: () => Promise<BoundSession | undefined>
  /** 每次连接前调用，返回可选 OpenClaw token（WS subprotocol）。 */
  readonly resolveOpenClawToken?: () => Promise<string | undefined>
  readonly bindPollIntervalMs?: number
  readonly bindTimeoutMs?: number
  readonly heartbeatIntervalMs?: number
  readonly reconnectMinMs?: number
  readonly reconnectMaxMs?: number
  readonly pushTimeoutMs?: number
  /** 可注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch
  /** 可注入 WebSocket 实现（测试用）。 */
  readonly WebSocketImpl?: typeof WebSocket
  /** 状态变更回调。 */
  readonly onStatus?: (status: GatewayStatus) => void
}

export class QzhuliGateway implements QzhuliChannel {
  private readonly options: QzhuliGatewayOptions
  private inboundHandler: ((msg: InboundMessage) => void | Promise<void>) | undefined
  private boundHandler: ((session: BoundSession) => void) | undefined
  private bindService: BindService | undefined
  private ws: WsClient | undefined
  private session: BoundSession | undefined
  private bindStatus: BindStatus
  private connected = false
  private closed = false

  constructor(options: QzhuliGatewayOptions) {
    this.options = options
    this.bindStatus = options.bindKey ? 'pending' : 'unbound'
  }

  get status(): GatewayStatus {
    return { bindStatus: this.bindStatus, connected: this.connected }
  }

  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void {
    this.inboundHandler = handler
  }

  onBound(handler: (session: BoundSession) => void): void {
    this.boundHandler = handler
  }

  async start(): Promise<void> {
    this.closed = false
    const session = await this.options.resolveSession?.()
    if (session) {
      this.session = session
      this.bindStatus = 'bound'
      this.emitStatus()
      await this.connectWs()
      return
    }
    if (this.options.bindKey) {
      this.bindStatus = 'pending'
      this.emitStatus()
      this.bindService = new BindService({
        environment: this.options.environment,
        bindKey: this.options.bindKey,
        ...(this.options.bindPollIntervalMs !== undefined ? { pollIntervalMs: this.options.bindPollIntervalMs } : {}),
        ...(this.options.bindTimeoutMs !== undefined ? { timeoutMs: this.options.bindTimeoutMs } : {}),
        ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
      })
      void this.runBind()
      return
    }
    this.bindStatus = 'error'
    this.emitStatus({ error: 'Qzhuli 未绑定：缺少 bindKey 或已绑定凭据' })
  }

  async stop(): Promise<void> {
    this.closed = true
    this.bindService?.cancel()
    this.bindService = undefined
    this.ws?.stop()
    this.ws = undefined
    this.connected = false
  }

  async send(convId: string, text: string): Promise<SendResult> {
    return pushMessage({
      environment: this.options.environment,
      convId,
      content: text,
      role: 0,
      ...(this.session ? { senderCid: this.session.senderCid } : {}),
      ...(this.options.pushTimeoutMs !== undefined ? { timeoutMs: this.options.pushTimeoutMs } : {}),
      ...(this.options.fetchImpl !== undefined ? { fetchImpl: this.options.fetchImpl } : {}),
    })
  }

  private async runBind(): Promise<void> {
    const service = this.bindService
    if (!service) return
    const result: BindRunResult = await service.run((session) => {
      this.session = session
      this.bindStatus = 'bound'
      this.emitStatus()
      this.boundHandler?.(session)
      void this.connectWs()
    })
    if (result === 'timeout' && !this.closed) {
      this.bindStatus = 'timeout'
      this.emitStatus({ error: 'Qzhuli 绑定超时（10 分钟内未在手机端确认）' })
    }
  }

  private async connectWs(): Promise<void> {
    const session = this.session
    if (!session || this.closed) return
    const openClawToken = await this.options.resolveOpenClawToken?.()
    const wsOptions: WsClientOptions = {
      url: wssOpenclawUrl(this.options.environment, {
        cid: session.senderCid,
        token: session.wsToken,
        convId: session.convId,
      }),
      ...(openClawToken !== undefined ? { openClawToken } : {}),
      ...(this.options.heartbeatIntervalMs !== undefined ? { heartbeatIntervalMs: this.options.heartbeatIntervalMs } : {}),
      ...(this.options.reconnectMinMs !== undefined ? { reconnectMinMs: this.options.reconnectMinMs } : {}),
      ...(this.options.reconnectMaxMs !== undefined ? { reconnectMaxMs: this.options.reconnectMaxMs } : {}),
      ...(this.options.WebSocketImpl !== undefined ? { WebSocketImpl: this.options.WebSocketImpl } : {}),
    }
    const client = new WsClient(wsOptions, {
      onMessage: (msg) => {
        if (this.inboundHandler) void this.inboundHandler(msg)
      },
      onConnected: () => {
        this.connected = true
        this.emitStatus()
      },
      onDisconnected: () => {
        this.connected = false
        this.emitStatus()
      },
      onError: (error) => {
        this.emitStatus({ error })
      },
    })
    this.ws = client
    client.start()
  }

  private emitStatus(extra?: { error?: string }): void {
    const status: GatewayStatus = {
      bindStatus: this.bindStatus,
      connected: this.connected,
      ...(extra?.error ? { error: extra.error } : {}),
    }
    this.options.onStatus?.(status)
  }}
