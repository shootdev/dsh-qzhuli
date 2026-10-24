import { describe, expect, it } from 'vitest'
import { convSessionId, QZHULI_SESSION_PREFIX } from '../../src/gateway/ids.ts'

describe('ids: 会话 id 派生', () => {
  it('前缀固定', () => {
    expect(QZHULI_SESSION_PREFIX).toBe('qzhuli:')
  })

  it('同一 conv_id 派生同一标识', () => {
    expect(convSessionId('abc')).toBe('qzhuli:abc')
    expect(convSessionId('abc')).toBe(convSessionId('abc'))
    expect(convSessionId('abc')).not.toBe(convSessionId('abd'))
  })
})
