/**
 * 消息来源声明合并：Q助理入站消息携带来源元数据进入 Harness 会话日志，
 * 全程可溯源（会话重建时能区分「Q助理消息」与其它来源）。
 */

import type {} from '@deepseek-ai/dsh-llm'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    qzhuli: {
      kind: 'qzhuli'
      convId: string
      senderCid: string
      messageId: string
    }
  }
}
