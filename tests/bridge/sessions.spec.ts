import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle } from '@deepseek-ai/dsh-agent'
import type { QzhuliConfig } from '../../src/config.ts'
import { disposeOwnedAgents, ensureAgent, sessionIdForConv } from '../../src/bridge/sessions.ts'

const cfg: QzhuliConfig = { workspacePath: '/tmp/qzhuli-workspace' }

interface FakeWorkspace {
  path: string
  attachSession: ReturnType<typeof vi.fn>
  detachSession: ReturnType<typeof vi.fn>
}

interface FakeCtx {
  agents: {
    get: ReturnType<typeof vi.fn>
    resume: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
  agentPresets: {
    resolve: ReturnType<typeof vi.fn>
    acquireScope: ReturnType<typeof vi.fn>
    mount: ReturnType<typeof vi.fn>
  }
  agentDefaultModel: { currentSelection: ReturnType<typeof vi.fn> }
  permissionPresets: { set: ReturnType<typeof vi.fn> }
  sessionTitle: { rename: ReturnType<typeof vi.fn> }
  workspaceRegistry: { create: ReturnType<typeof vi.fn> }
  workspaces: FakeWorkspace[]
  handles: AgentHandle[]
}

function fakeAgent(): Agent {
  return { session: { id: 's' } } as unknown as Agent
}

function makeHandle(agent: Agent): AgentHandle {
  return { agent, dispose: vi.fn(async () => {}) }
}

function makeCtx(overrides: Partial<FakeCtx> = {}): FakeCtx & { ctx: Context } {
  const workspaces: FakeWorkspace[] = []
  const handles: AgentHandle[] = []
  const base: FakeCtx = {
    agents: {
      get: vi.fn(() => undefined),
      resume: vi.fn(async () => {
        throw new Error('session not found')
      }),
      create: vi.fn(async () => {
        const handle = makeHandle(fakeAgent())
        handles.push(handle)
        return handle
      }),
    },
    agentPresets: {
      resolve: vi.fn(async () => ({ id: 'default' })),
      acquireScope: vi.fn(async () => ({ [Symbol.asyncDispose]: async () => {} })),
      mount: vi.fn(async () => {}),
    },
    agentDefaultModel: { currentSelection: vi.fn(() => ({ provider: 'deepseek', model: 'deepseek-chat' })) },
    permissionPresets: { set: vi.fn() },
    sessionTitle: { rename: vi.fn() },
    workspaceRegistry: {
      create: vi.fn(async () => {
        const workspace: FakeWorkspace = {
          path: '/tmp/qzhuli-workspace',
          attachSession: vi.fn(async () => {}),
          detachSession: vi.fn(async () => {}),
        }
        workspaces.push(workspace)
        return workspace
      }),
    },
    workspaces,
    handles,
  }
  const merged = { ...base, ...overrides }
  return { ...merged, ctx: merged as unknown as Context }
}

describe('sessions: sessionIdForConv', () => {
  it('确定性派生', () => {
    expect(sessionIdForConv('c1')).toBe('qzhuli:c1')
    expect(sessionIdForConv('c1')).toBe(sessionIdForConv('c1'))
    expect(sessionIdForConv('c1')).not.toBe(sessionIdForConv('c2'))
  })
})

describe('sessions: ensureAgent', () => {
  it('live 命中 → 复用，不新建', async () => {
    const agent = fakeAgent()
    const { ctx, handles } = makeCtx({
      agents: {
        get: vi.fn(() => agent),
        resume: vi.fn(async () => {
          throw new Error('unused')
        }),
        create: vi.fn(async () => {
          throw new Error('unused')
        }),
      },
    })
    await expect(ensureAgent(ctx, 'c1', cfg)).resolves.toBe(agent)
    expect(handles.length).toBe(0)
  })

  it('resume 成功 → 复用恢复的 handle', async () => {
    const agent = fakeAgent()
    const { ctx } = makeCtx({
      agents: {
        get: vi.fn(() => undefined),
        resume: vi.fn(async () => makeHandle(agent)),
        create: vi.fn(async () => {
          throw new Error('unused')
        }),
      },
    })
    await expect(ensureAgent(ctx, 'c1', cfg)).resolves.toBe(agent)
  })

  it('resume 不存在 → create 并完成装配', async () => {
    const { ctx, workspaces, handles } = makeCtx()
    const agent = await ensureAgent(ctx, 'c1', cfg)
    expect(agent).toBeDefined()
    expect(handles.length).toBe(1)
    expect(handles[0]?.agent).toBe(agent)
    expect(workspaces.length).toBe(1)
    expect(workspaces[0]?.attachSession).toHaveBeenCalledWith('qzhuli:c1')
    expect(ctx.permissionPresets.set).toHaveBeenCalledWith(agent.session, 'default')
    expect(ctx.sessionTitle.rename).toHaveBeenCalledWith(agent.session, 'Q助理 c1')
    expect(ctx.agents.create).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'qzhuli:c1', meta: { cwd: '/tmp/qzhuli-workspace', agentPreset: 'default' } }),
    )
  })

  it('装配失败 → dispose 并上抛', async () => {
    const failingWorkspace = {
      path: '/tmp/qzhuli-workspace',
      attachSession: vi.fn(async () => {
        throw new Error('attach failed')
      }),
      detachSession: vi.fn(async () => {}),
    }
    const { ctx, handles } = makeCtx({
      workspaceRegistry: { create: vi.fn(async () => failingWorkspace) },
    })
    await expect(ensureAgent(ctx, 'c1', cfg)).rejects.toThrow('attach failed')
    expect(handles.length).toBe(1)
    expect(handles[0]?.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposeOwnedAgents 释放全部持有句柄', async () => {
    const { ctx, handles } = makeCtx()
    await ensureAgent(ctx, 'c1', cfg)
    await ensureAgent(ctx, 'c2', cfg)
    expect(handles.length).toBe(2)
    await disposeOwnedAgents()
    for (const handle of handles) {
      expect(handle.dispose).toHaveBeenCalledTimes(1)
    }
  })
})
