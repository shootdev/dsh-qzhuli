/**
 * 扫码绑定轮询：按固定间隔轮询 check_bind_status，直至 status=1（或 "bound"），
 * 返回会话凭据（conv_id / cid / bind_token）。
 */

import { checkBindStatusUrl, PROTOCOL } from './protocol.ts'
import type { BoundSession } from './port.ts'

/** 一次轮询的返回：未就绪为 undefined。 */
export type BindPollResult = BoundSession | undefined

/** 整个绑定流程的结束原因。 */
export type BindRunResult = 'bound' | 'timeout' | 'cancelled'

export interface BindServiceOptions {
  readonly environment: 'release' | 'dev'
  readonly bindKey: string
  readonly pollIntervalMs?: number
  readonly timeoutMs?: number
  /** 可注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch
}

/** 从绑定接口响应中提取凭据；status 未就绪或字段不全返回 undefined。 */
export function parseBoundPayload(body: unknown): BindPollResult {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const payload = (typeof record.data === 'object' && record.data !== null ? record.data : record) as Record<string, unknown>
  const status = String(payload.status ?? '').toLowerCase()
  if (status !== '1' && status !== 'bound') return undefined
  const convId = String(payload.conversation_id ?? payload.conv_id ?? '').trim()
  const senderCid = String(payload.cid ?? '').trim()
  const wsToken = String(payload.bind_token ?? payload.token ?? '').trim()
  if (!convId || !senderCid || !wsToken) return undefined
  return { convId, senderCid, wsToken }
}

export class BindService {
  private readonly environment: 'release' | 'dev'
  private readonly bindKey: string
  private readonly pollIntervalMs: number
  private readonly timeoutMs: number
  private readonly fetchImpl: typeof fetch
  private cancelled = false

  constructor(options: BindServiceOptions) {
    this.environment = options.environment
    this.bindKey = options.bindKey
    this.pollIntervalMs = options.pollIntervalMs ?? PROTOCOL.bindPollIntervalMs
    this.timeoutMs = options.timeoutMs ?? PROTOCOL.bindTimeoutMs
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  /** 执行一次轮询。 */
  async pollOnce(): Promise<BindPollResult> {
    const response = await this.fetchImpl(checkBindStatusUrl(this.environment, this.bindKey), {
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`bind status http ${response.status}`)
    return parseBoundPayload((await response.json()) as unknown)
  }

  /** 循环轮询直到 绑定成功 / 超时 / 取消。网络抖动不中断（与 Hermes 行为一致）。 */
  async run(onBound: (session: BoundSession) => void): Promise<BindRunResult> {
    const deadline = Date.now() + this.timeoutMs
    while (!this.cancelled) {
      if (Date.now() > deadline) return 'timeout'
      try {
        const session = await this.pollOnce()
        if (session) {
          onBound(session)
          return 'bound'
        }
      } catch {
        if (this.cancelled) return 'cancelled'
        // 瞬态网络错误：继续下一轮
      }
      await sleep(this.pollIntervalMs)
    }
    return 'cancelled'
  }

  cancel(): void {
    this.cancelled = true
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
