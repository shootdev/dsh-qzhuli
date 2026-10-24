/** 会话 id 派生：同一 Q助理会话永远映射到同一个 Harness Session。零依赖。 */

/** Q助理会话 id 前缀。 */
export const QZHULI_SESSION_PREFIX = 'qzhuli:'

/** 由 Q助理 conv_id 派生确定性 Session 标识（未加品牌类型；桥接层负责 brandString）。 */
export function convSessionId(convId: string): string {
  return `${QZHULI_SESSION_PREFIX}${convId}`
}
