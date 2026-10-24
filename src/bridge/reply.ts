/**
 * 出站回复：回合结束后增量读取 assistant/message 事件并渲染为纯文本。
 * 不维护自己的「历史回复」状态 —— Harness 会话日志就是唯一事实源。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'

/** 把 assistant 消息内容渲染为纯文本（text 块按行拼接；reasoning/图像等块忽略）。 */
export function renderTextBlocks(message: AssistantMessage): string {
  return message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
}

/** 会话当前最新事件 seq（无事件时 0）。作为「回合开始前游标」。 */
export async function currentSeq(ctx: Context, sessionId: SessionId): Promise<number> {
  const records = await ctx.sessionQuery.listEvents(sessionId)
  const last = records[records.length - 1]
  return last ? last.seq : 0
}

export interface AssistantReply {
  readonly text: string
  /** 回合是否被中断（中断也照发前缀文本）。 */
  readonly interrupted: boolean
}

/** 读取游标之后最后一个 assistant/message 事件并渲染文本。 */
export async function readLastAssistantReply(
  ctx: Context,
  sessionId: SessionId,
  afterSeq: number,
): Promise<AssistantReply> {
  const records = await ctx.sessionQuery.listEvents(sessionId)
  const candidates = records.filter((record) => record.seq > afterSeq && record.type === 'assistant/message')
  const last = candidates[candidates.length - 1]
  if (!last) return { text: '', interrupted: false }
  const window = await ctx.sessionQuery.readEvent({ sessionId, seq: last.seq, before: 0, after: 0 })
  const event = window.target
  if (event.type !== 'assistant/message') return { text: '', interrupted: false }
  return { text: renderTextBlocks(event.data.message), interrupted: event.data.interrupted === true }
}
