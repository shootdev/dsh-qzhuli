import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventRecord, SessionEventWindow } from '@deepseek-ai/dsh-session-query'
import { currentSeq, readLastAssistantReply, renderTextBlocks } from '../../src/bridge/reply.ts'
import type { AssistantMessage } from '@deepseek-ai/dsh-llm'

function textMessage(id: string, blocks: AssistantMessage['content']): AssistantMessage {
  return { id, role: 'assistant', content: blocks } as unknown as AssistantMessage
}

describe('reply: renderTextBlocks', () => {
  it('只拼接 text 块', () => {
    const message = textMessage('m1', [
      { type: 'text', text: '第一行' },
      { type: 'text', text: '第二行' },
    ])
    expect(renderTextBlocks(message)).toBe('第一行\n第二行')
  })

  it('忽略非 text 块', () => {
    const message = textMessage('m2', [{ type: 'text', text: '只留我' }, { type: 'reasoning', text: '思考' }])
    expect(renderTextBlocks(message)).toBe('只留我')
  })
})

describe('reply: currentSeq / readLastAssistantReply', () => {
  function fakeCtx(records: SessionEventRecord[], readTarget?: SessionEventWindow['target']): Context {
    return {
      sessionQuery: {
        listEvents: vi.fn(async () => records),
        readEvent: vi.fn(async () => ({ target: readTarget })),
      },
    } as unknown as Context
  }

  it('currentSeq：空会话为 0，有记录取最后 seq', async () => {
    const empty = fakeCtx([])
    expect(await currentSeq(empty, 'qzhuli:c1' as never)).toBe(0)

    const records = [
      { seq: 3, type: 'user/message', time: 1, data: {} },
      { seq: 4, type: 'assistant/message', time: 2, data: {} },
    ] as unknown as SessionEventRecord[]
    expect(await currentSeq(fakeCtx(records), 'qzhuli:c1' as never)).toBe(4)
  })

  it('游标后无 assistant/message → 空回复', async () => {
    const records = [
      { seq: 5, type: 'user/message', time: 1, data: {} },
    ] as unknown as SessionEventRecord[]
    const ctx = fakeCtx(records)
    await expect(readLastAssistantReply(ctx, 'qzhuli:c1' as never, 0)).resolves.toEqual({ text: '', interrupted: false })
  })

  it('游标后取最后一个 assistant/message 并渲染', async () => {
    const records = [
      { seq: 5, type: 'user/message', time: 1, data: {} },
      { seq: 6, type: 'assistant/message', time: 2, data: {} },
      { seq: 7, type: 'assistant/message', time: 3, data: {} },
    ] as unknown as SessionEventRecord[]
    const target = {
      type: 'assistant/message',
      seq: 7,
      time: 3,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'm7', role: 'assistant', content: [{ type: 'text', text: '最终回复' }] },
        stream: [],
      },
    } as unknown as SessionEventWindow['target']
    const ctx = fakeCtx(records, target)
    const result = await readLastAssistantReply(ctx, 'qzhuli:c1' as never, 5)
    expect(result.text).toBe('最终回复')
    expect(result.interrupted).toBe(false)
  })

  it('中断回合返回 interrupted=true', async () => {
    const records = [
      { seq: 6, type: 'assistant/message', time: 2, data: {} },
    ] as unknown as SessionEventRecord[]
    const target = {
      type: 'assistant/message',
      seq: 6,
      time: 2,
      data: {
        turn: 1,
        step: 1,
        message: { id: 'm6', role: 'assistant', content: [{ type: 'text', text: '前缀' }] },
        stream: [],
        interrupted: true,
      },
    } as unknown as SessionEventWindow['target']
    const ctx = fakeCtx(records, target)
    const result = await readLastAssistantReply(ctx, 'qzhuli:c1' as never, 0)
    expect(result.text).toBe('前缀')
    expect(result.interrupted).toBe(true)
  })
})
