/**
 * 会话生命周期：确定性 SessionId 派生 + ensureAgent（live 复用 / resume 恢复 / create 新建）。
 * 与 Harness 的全部运行时耦合都收敛在本文件与 index.ts。
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type { QzhuliConfig } from '../config.ts'
import { convSessionId } from '../gateway/ids.ts'

/** 本插件创建/恢复并持有的 Agent 句柄（插件停止时统一 dispose）。 */
const ownedHandles = new Map<SessionId, AgentHandle>()

/** 由 Q助理 conv_id 派生 Harness SessionId（确定性，重启后自动恢复同一会话）。 */
export function sessionIdForConv(convId: string): SessionId {
  return brandString<SessionId>(convSessionId(convId))
}

/** 释放本插件持有的全部 Agent。 */
export async function disposeOwnedAgents(): Promise<void> {
  const handles = [...ownedHandles.values()]
  ownedHandles.clear()
  await Promise.allSettled(handles.map((handle) => handle.dispose()))
}

/**
 * 确保目标会话存在一个 live Agent：优先复用 ctx.agents.get，其次 resume，最后 create。
 * resume 失败且为「持久化中不存在」时走 create；其余失败直接上抛（fail loud）。
 */
export async function ensureAgent(ctx: Context, convId: string, cfg: QzhuliConfig): Promise<Agent> {
  const sessionId = sessionIdForConv(convId)
  const live = ctx.agents.get(sessionId)
  if (live) return live

  const presetName = cfg.agentPreset ?? 'default'
  const permissionPreset = cfg.permissionPreset ?? 'default'
  const preset = await ctx.agentPresets.resolve(presetName)
  await using presetScope = await ctx.agentPresets.acquireScope(preset.id)
  void presetScope

  const agentOptions: AgentOptions = cfg.model ?? { ...ctx.agentDefaultModel.currentSelection() }
  const setup = async (agentCtx: Context): Promise<void> => {
    await ctx.agentPresets.mount(agentCtx, preset.id)
  }

  try {
    const handle = await ctx.agents.resume({
      resumeSessionId: sessionId,
      agentOptions,
      setup,
    })
    ownedHandles.set(sessionId, handle)
    return handle.agent
  } catch {
    // 持久化中不存在该会话 → 新建
  }

  const handle = await createAgent(ctx, sessionId, convId, cfg, presetName, permissionPreset, agentOptions, setup)
  ownedHandles.set(sessionId, handle)
  return handle.agent
}

async function createAgent(
  ctx: Context,
  sessionId: SessionId,
  convId: string,
  cfg: QzhuliConfig,
  presetName: string,
  permissionPreset: string,
  agentOptions: AgentOptions,
  setup: (agentCtx: Context) => Promise<void>,
): Promise<AgentHandle> {
  const workspace = await ctx.workspaceRegistry.create(cfg.workspacePath)
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: workspace.path, agentPreset: presetName },
    agentOptions,
    setup,
  })
  let attached = false
  try {
    await workspace.attachSession(sessionId)
    attached = true
    ctx.permissionPresets.set(handle.agent.session, permissionPreset)
    ctx.sessionTitle.rename(handle.agent.session, cfg.title ?? `Q助理 ${convId}`)
  } catch (error) {
    if (attached) {
      try {
        await workspace.detachSession(sessionId)
      } catch {
        // 回滚失败仅记入日志（agent 已 dispose，会话残留由宿主清理）
      }
    }
    await handle.dispose()
    throw error
  }
  return handle
}
