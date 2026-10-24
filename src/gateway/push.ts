/**
 * push_message HTTP 客户端：把 Agent 回复推回 Q助理。
 */

import { PROTOCOL, pushMessageUrl } from './protocol.ts'
import type { SendResult } from './port.ts'

export interface PushMessageOptions {
  readonly environment: 'release' | 'dev'
  readonly convId: string
  readonly content: string
  /** 0 = Assistant（默认），1 = User。 */
  readonly role?: 0 | 1
  /** 已绑定会话的 sender_cid（可选）。 */
  readonly senderCid?: string
  readonly timeoutMs?: number
  /** 可注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch
}

export async function pushMessage(options: PushMessageOptions): Promise<SendResult> {
  const payload: Record<string, unknown> = {
    conv_id: options.convId,
    content: options.content,
    msg_type: 1, // LobsterAI 实测值
    role: options.role ?? 0,
  }
  if (options.senderCid) payload.sender_cid = options.senderCid
  const fetchImpl = options.fetchImpl ?? fetch
  try {
    const response = await fetchImpl(pushMessageUrl(options.environment), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(options.timeoutMs ?? PROTOCOL.pushTimeoutMs),
    })
    if (!response.ok) return { success: false, error: `push http ${response.status}` }
    const body = (await response.json()) as unknown
    const code = typeof body === 'object' && body !== null ? (body as Record<string, unknown>).code : undefined
    if (typeof code === 'number' && code !== 200) {
      const message = typeof body === 'object' && body !== null ? String((body as Record<string, unknown>).msg ?? code) : String(code)
      return { success: false, error: `qzhuli push error: ${message}` }
    }
    return { success: true, messageId: String(Date.now()) }
  } catch (error) {
    return { success: false, error: String(error) }
  }
}
