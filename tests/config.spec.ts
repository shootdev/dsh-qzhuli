import { describe, expect, it } from 'vitest'
import { validateConfig } from '../src/config.ts'

describe('config: validateConfig', () => {
  it('最简合法配置', () => {
    expect(validateConfig({ workspacePath: '/tmp/w' })).toEqual({ workspacePath: '/tmp/w' })
  })

  it('全量配置归一化', () => {
    const cfg = validateConfig({
      workspacePath: '/tmp/w',
      environment: 'dev',
      agentPreset: 'deepseek-chat',
      permissionPreset: 'owner',
      title: '我的 Q助理',
      allowedUsers: ['s1', 's2'],
      model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 },
      maxMessageLength: 500,
      bindKey: 'bk1',
    })
    expect(cfg).toEqual({
      workspacePath: '/tmp/w',
      environment: 'dev',
      agentPreset: 'deepseek-chat',
      permissionPreset: 'owner',
      title: '我的 Q助理',
      allowedUsers: ['s1', 's2'],
      model: { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 },
      maxMessageLength: 500,
      bindKey: 'bk1',
    })
  })

  it('空串字段被剔除，回落默认', () => {
    const cfg = validateConfig({
      workspacePath: '/tmp/w',
      agentPreset: '',
      permissionPreset: '  ',
      title: '',
    })
    expect(cfg).toEqual({ workspacePath: '/tmp/w' })
  })

  it('非法输入抛 TypeError', () => {
    expect(() => validateConfig(null)).toThrow(TypeError)
    expect(() => validateConfig('x')).toThrow(TypeError)
    expect(() => validateConfig({})).toThrow(/workspacePath/)
    expect(() => validateConfig({ workspacePath: '' })).toThrow(/workspacePath/)
    expect(() => validateConfig({ workspacePath: 'relative' })).toThrow(/absolute/)
    expect(() => validateConfig({ workspacePath: '/tmp/w', environment: 'prod' })).toThrow(/environment/)
    expect(() => validateConfig({ workspacePath: '/tmp/w', maxMessageLength: 0 })).toThrow(/maxMessageLength/)
    expect(() => validateConfig({ workspacePath: '/tmp/w', maxMessageLength: 1.5 })).toThrow(/maxMessageLength/)
    expect(() => validateConfig({ workspacePath: '/tmp/w', allowedUsers: ['ok', 3] })).toThrow(/allowedUsers/)
    expect(() => validateConfig({ workspacePath: '/tmp/w', model: { provider: '', model: 'x' } })).toThrow(/model/)
    expect(() => validateConfig({ workspacePath: '/tmp/w', model: { provider: 'p', model: 'm', maxTokens: -1 } })).toThrow(/maxTokens/)
  })
})
