/**
 * 插件配置：只承载非密钥字段。
 * 密钥与绑定凭据一律走 Harness credentials 子系统（环境变量 QZHULI_*，见 bridge/index.ts）。
 */

import { isAbsolute } from 'node:path'

export interface QzhuliModelConfig {
  readonly provider: string
  readonly model: string
  readonly maxTokens?: number
}

export interface QzhuliConfig {
  /** release = 生产，dev = 测试。缺省 release。 */
  readonly environment?: 'release' | 'dev'
  /** 会话工作区绝对路径（必填）。 */
  readonly workspacePath: string
  /** 会话 agent 预设名。缺省 'default'（需与宿主 profile 对齐）。 */
  readonly agentPreset?: string
  /** 会话权限预设名。缺省 'default'。 */
  readonly permissionPreset?: string
  /** 会话标题。缺省「Q助理 <conv_id>」。 */
  readonly title?: string
  /** sender_cid 白名单；缺省 = 仅处理绑定会话的消息。 */
  readonly allowedUsers?: readonly string[]
  /** 显式模型路由；缺省取 ctx.agentDefaultModel.currentSelection()。 */
  readonly model?: QzhuliModelConfig
  /** 入站消息最大长度（超出截断），缺省 2000。 */
  readonly maxMessageLength?: number
  /** 绑定密钥：无已绑定凭据时启用扫码绑定轮询。 */
  readonly bindKey?: string
}

export const QZHULI_DEFAULTS = {
  agentPreset: 'default',
  permissionPreset: 'default',
  maxMessageLength: 2000,
} as const

/** 校验并归一化配置；非法输入抛 TypeError（插件加载即失败，符合 fail-loud 约定）。 */
export function validateConfig(input: unknown): QzhuliConfig {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('qzhuli config must be an object')
  }
  const record = input as Record<string, unknown>

  const workspacePath = record.workspacePath
  if (typeof workspacePath !== 'string' || workspacePath.trim() === '') {
    throw new TypeError('qzhuli config workspacePath must be a non-empty absolute path')
  }
  if (!isAbsolute(workspacePath)) {
    throw new TypeError(`qzhuli config workspacePath must be absolute, got ${JSON.stringify(workspacePath)}`)
  }

  const environment = record.environment
  if (environment !== undefined && environment !== 'release' && environment !== 'dev') {
    throw new TypeError(`qzhuli config environment must be 'release' or 'dev', got ${JSON.stringify(environment)}`)
  }

  const maxMessageLength = record.maxMessageLength
  if (
    maxMessageLength !== undefined &&
    (typeof maxMessageLength !== 'number' || !Number.isSafeInteger(maxMessageLength) || maxMessageLength <= 0)
  ) {
    throw new TypeError('qzhuli config maxMessageLength must be a positive safe integer')
  }

  const allowedUsers = record.allowedUsers
  if (
    allowedUsers !== undefined &&
    (!Array.isArray(allowedUsers) || allowedUsers.some((user) => typeof user !== 'string' || user === ''))
  ) {
    throw new TypeError('qzhuli config allowedUsers must be an array of non-empty strings')
  }

  const model = validateModel(record.model)

  let cfg: QzhuliConfig = { workspacePath }
  if (environment !== undefined) cfg = { ...cfg, environment }
  if (typeof record.agentPreset === 'string' && record.agentPreset.trim() !== '') {
    cfg = { ...cfg, agentPreset: record.agentPreset.trim() }
  }
  if (typeof record.permissionPreset === 'string' && record.permissionPreset.trim() !== '') {
    cfg = { ...cfg, permissionPreset: record.permissionPreset.trim() }
  }
  if (typeof record.title === 'string' && record.title.trim() !== '') {
    cfg = { ...cfg, title: record.title.trim() }
  }
  if (allowedUsers !== undefined) cfg = { ...cfg, allowedUsers: [...(allowedUsers as string[])] }
  if (model !== undefined) cfg = { ...cfg, model }
  if (maxMessageLength !== undefined) cfg = { ...cfg, maxMessageLength }
  if (typeof record.bindKey === 'string' && record.bindKey.trim() !== '') {
    cfg = { ...cfg, bindKey: record.bindKey.trim() }
  }
  return cfg
}

function validateModel(input: unknown): QzhuliModelConfig | undefined {
  if (input === undefined || input === null) return undefined
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('qzhuli config model must be an object { provider, model, maxTokens? }')
  }
  const record = input as Record<string, unknown>
  const provider = record.provider
  const model = record.model
  if (typeof provider !== 'string' || provider.trim() === '' || typeof model !== 'string' || model.trim() === '') {
    throw new TypeError('qzhuli config model.provider and model.model must be non-empty strings')
  }
  const maxTokens = record.maxTokens
  if (
    maxTokens !== undefined &&
    (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw new TypeError('qzhuli config model.maxTokens must be a positive safe integer')
  }
  let result: QzhuliModelConfig = { provider: provider.trim(), model: model.trim() }
  if (maxTokens !== undefined) result = { ...result, maxTokens }
  return result
}
