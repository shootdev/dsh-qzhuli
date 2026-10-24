/**
 * Q助理网关插件入口：装配协议层（src/gateway）与 Harness 适配层（src/bridge）。
 *
 * 依赖面（运行时 import）：
 *   - @deepseek-ai/cordis（Context）、@deepseek-ai/dsh-brand（brandString）
 *   - @deepseek-ai/dsh-credentials（credentialRef）、@deepseek-ai/dsh-llm（createUserMessage/errorChain）
 * 其余均为类型级依赖（声明合并/仅类型）。
 */

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-credentials'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import { validateConfig, type QzhuliConfig } from './config.ts'
import { QzhuliGateway } from './gateway/gateway.ts'
import type { BoundSession, InboundMessage } from './gateway/port.ts'
import { disposeOwnedAgents, ensureAgent, sessionIdForConv } from './bridge/sessions.ts'
import { currentSeq, readLastAssistantReply } from './bridge/reply.ts'
import type {} from './bridge/source.ts'
import QRCode from 'qrcode'

export const name = 'qzhuli'

export const inject = [
  'agents',
  'agentDefaultModel',
  'agentPresets',
  'permissionPresets',
  'sessionTitle',
  'sessionQuery',
  'workspaceRegistry',
  'credentials',
  'sessionPersistence',
] as const

/** 绑定/密钥相关环境变量名（经 Harness credentials 子系统解析）。 */
const ENV_BIND_KEY = 'QZHULI_BIND_KEY'
const ENV_SENDER_CID = 'QZHULI_SENDER_CID'
const ENV_CONV_ID = 'QZHULI_CONV_ID'
const ENV_WS_TOKEN = 'QZHULI_WS_TOKEN'
const ENV_OPENCLAW_TOKEN = 'QZHULI_OPENCLAW_TOKEN'

export function apply(ctx: Context, config: unknown): void {
  const cfg = validateConfig(config)

  // status-only：不启动网关，只向 web 进程暴露绑定状态 API（client 设置页读取）。
  if ((cfg.mode ?? 'gateway') === 'status-only') {
    setupStatusOnly(ctx, cfg)
    return
  }

  let gateway: QzhuliGateway | undefined

  ctx.effect(() => async () => {
    await gateway?.stop()
    await disposeOwnedAgents()
  })

  void (async () => {
    const bindKey = await resolveBindKey(ctx, cfg)
    gateway = new QzhuliGateway({
      environment: cfg.environment ?? 'release',
      ...(bindKey ? { bindKey } : {}),
      resolveSession: () => resolveBoundSession(ctx),
      resolveOpenClawToken: async () => (await ctx.credentials.resolve(credentialRef(ENV_OPENCLAW_TOKEN)))?.value,
      onStatus: (status) => {
        ctx.logger.info(
          `qzhuli: bind=${status.bindStatus} connected=${status.connected}${status.error ? ` error=${status.error}` : ''}`,
        )
      },
    })
    gateway.onBound((session) => {
      void persistBoundSession(ctx, session)
    })
    gateway.onInbound((msg) => {
      enqueue(ctx, gateway as QzhuliGateway, cfg, msg)
    })
    if (bindKey && !(await resolveBoundSession(ctx))) {
      await exposeBindQrCode(ctx, cfg, bindKey)
    }
    await gateway.start()
  })().catch((error: unknown) => {
    ctx.logger.error(`qzhuli: gateway start failed: ${errorChain(error)}`)
  })
}

/** 解析绑定密钥：显式配置 → credentials 持久值 → 自动生成并持久化（重启后不变）。 */
async function resolveBindKey(ctx: Context, cfg: QzhuliConfig): Promise<string | undefined> {
  if (cfg.bindKey) return cfg.bindKey
  const existing = await ctx.credentials.resolve(credentialRef(ENV_BIND_KEY))
  if (existing) return existing.value
  const generated = randomUUID()
  await ctx.credentials.set(credentialRef(ENV_BIND_KEY), generated)
  ctx.logger.info('qzhuli: generated bind key and persisted (QZHULI_BIND_KEY)')
  return generated
}

/** 把扫码绑定负载写入工作区并打日志（与 Hermes 协议一致：{"type":"imnut_bind","key":...,"id":2}）。 */
async function exposeBindQrCode(ctx: Context, cfg: QzhuliConfig, bindKey: string): Promise<void> {
  const payload = JSON.stringify({ type: 'imnut_bind', key: bindKey, id: 2 })
  try {
    await writeFile(join(cfg.workspacePath, 'bind-qrcode.txt'), `${payload}\n`, 'utf8')
  } catch (error: unknown) {
    ctx.logger.warn(`qzhuli: write bind-qrcode.txt failed: ${errorChain(error)}`)
  }
  ctx.logger.info(`qzhuli: 请用手机 Q助理 App 扫码绑定 → ${payload}`)
}

/** 每会话串行队列：避免 followup 回合交错。 */
const queues = new Map<string, Promise<void>>()

function enqueue(ctx: Context, gateway: QzhuliGateway, cfg: QzhuliConfig, msg: InboundMessage): void {
  const previous = queues.get(msg.convId) ?? Promise.resolve()
  const next = previous
    .then(() => processMessage(ctx, gateway, cfg, msg))
    .catch((error: unknown) => {
      ctx.logger.warn(`qzhuli: conv ${msg.convId} turn failed: ${errorChain(error)}`)
    })
  queues.set(msg.convId, next)
  void next.finally(() => {
    if (queues.get(msg.convId) === next) queues.delete(msg.convId)
  })
}

async function processMessage(
  ctx: Context,
  gateway: QzhuliGateway,
  cfg: QzhuliConfig,
  msg: InboundMessage,
): Promise<void> {
  // 服务端只推送文本消息（imnut 端已按 MsgType_Text 过滤），且实际下发 msg_type=0；
  // 兼容 LobsterAI 语义（push 用 1）——0 与 1 都视为文本处理。
  if (msg.msgType !== 0 && msg.msgType !== 1) {
    ctx.logger.info(`qzhuli: ignore non-text message msg_type=${msg.msgType} conv=${msg.convId}`)
    return
  }
  const bound = await resolveBoundSession(ctx)
  if (bound && bound.convId !== msg.convId) {
    ctx.logger.warn(`qzhuli: ignore message from non-bound conv ${msg.convId}`)
    return
  }
  if (cfg.allowedUsers?.length && !cfg.allowedUsers.includes(msg.senderCid)) {
    ctx.logger.warn(`qzhuli: ignore message from non-allowed sender ${msg.senderCid}`)
    return
  }

  const content = msg.content.slice(0, cfg.maxMessageLength ?? 2000)
  const sessionId = sessionIdForConv(msg.convId)
  const agent = await ensureAgent(ctx, msg.convId, cfg)
  const before = await currentSeq(ctx, sessionId)
  const userMessage = createUserMessage({
    content: [{ type: 'text', text: content }],
    source: { kind: 'qzhuli', convId: msg.convId, senderCid: msg.senderCid, messageId: msg.messageId },
  })
  agent.followup(userMessage)
  await agent.whenIdle()

  const reply = await readLastAssistantReply(ctx, sessionId, before)
  const text = reply.text.trim()
  if (text) {
    const result = await gateway.send(msg.convId, text)
    if (!result.success) {
      ctx.logger.warn(`qzhuli: push failed: ${result.error ?? 'unknown'}`)
    }
  } else if (reply.interrupted) {
    ctx.logger.info(`qzhuli: conv ${msg.convId} reply empty after interruption`)
  }
}

/** 解析已绑定凭据（每次连接/入站现解析，支持热更新）。 */
async function resolveBoundSession(ctx: Context): Promise<BoundSession | undefined> {
  const [senderCid, convId, wsToken] = await Promise.all([
    ctx.credentials.resolve(credentialRef(ENV_SENDER_CID)),
    ctx.credentials.resolve(credentialRef(ENV_CONV_ID)),
    ctx.credentials.resolve(credentialRef(ENV_WS_TOKEN)),
  ])
  if (senderCid && convId && wsToken) {
    return { convId: convId.value, senderCid: senderCid.value, wsToken: wsToken.value }
  }
  return undefined
}

/** 绑定成功后把凭据写入 Harness credentials（幂等），重启免扫码。 */
async function persistBoundSession(ctx: Context, session: BoundSession): Promise<void> {
  try {
    await Promise.all([
      ctx.credentials.set(credentialRef(ENV_SENDER_CID), session.senderCid),
      ctx.credentials.set(credentialRef(ENV_CONV_ID), session.convId),
      ctx.credentials.set(credentialRef(ENV_WS_TOKEN), session.wsToken),
    ])
    ctx.logger.info(`qzhuli: bound session persisted conv=${session.convId}`)
  } catch (error: unknown) {
    ctx.logger.warn(`qzhuli: persist bound session failed: ${errorChain(error)}`)
  }
}

/** 绑定状态 API 路径（client 设置页轮询）。 */
export const BIND_STATUS_PATH = '/api/qzhuli/bind-status'

/** webServer 可选注入：status-only 模式向 web 进程注册只读绑定状态 API。 */
function setupStatusOnly(ctx: Context, cfg: QzhuliConfig): void {
  ctx.inject(['webServer', 'connection'], (webCtx) => {
    const carrier = webCtx as unknown as StatusOnlyContext
    carrier.effect(
      () => carrier.webServer.register({
        kind: 'exact',
        path: BIND_STATUS_PATH,
        handler: (req, res) => { void handleBindStatus(carrier, cfg, req, res) },
      }),
      `qzhuli: GET ${BIND_STATUS_PATH}`,
    )
    ctx.logger.info(`qzhuli: status-only mode — serving ${BIND_STATUS_PATH}`)
  })
}

/** ctx.inject(['webServer','connection']) 后 webCtx 的窄类型（宿主源码类型不锁定）。 */
interface StatusOnlyContext extends Context {
  webServer: {
    register(route: {
      kind: 'exact' | 'prefix'
      path: string
      handler(req: IncomingMessage, res: ServerResponse): void | Promise<void>
    }): () => void
  }
}

/** 绑定状态接口响应体。 */
export interface BindStatusPayload {
  readonly bound: boolean
  readonly bindKey?: string
  readonly convId?: string
  readonly senderCid?: string
  /** 未绑定时：扫码绑定二维码 PNG dataURL（imnut_bind 负载）。 */
  readonly qrcodeDataUrl?: string
  readonly workspacePath: string
}

async function handleBindStatus(ctx: Context, cfg: QzhuliConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const connection = Reflect.get(ctx, 'connection') as
    | { requestRejection(request: { readonly headers: IncomingMessage['headers'] }): 401 | 403 | undefined }
    | undefined
  const rejection = connection?.requestRejection?.(req)
  if (rejection !== undefined) {
    res.statusCode = rejection
    res.end()
    return
  }
  try {
    const body = await buildStatusPayload(ctx, cfg)
    sendJson(res, 200, body)
  } catch (error: unknown) {
    ctx.logger.warn(`qzhuli: bind-status failed: ${errorChain(error)}`)
    sendJson(res, 500, { error: errorChain(error) })
  }
}

/** 组装绑定状态：bound（凭据直连）+ bindKey（自动生成/持久化）+ 未绑定二维码。 */
async function buildStatusPayload(ctx: Context, cfg: QzhuliConfig): Promise<BindStatusPayload> {
  const bound = await resolveBoundSession(ctx)
  const bindKey = await resolveBindKey(ctx, cfg)
  // 可变中间态：构造完成后整体作为 readonly BindStatusPayload 返回。
  const payload: {
    bound: boolean
    bindKey?: string
    convId?: string
    senderCid?: string
    qrcodeDataUrl?: string
    workspacePath: string
  } = {
    bound: bound !== undefined,
    ...(bindKey === undefined ? {} : { bindKey }),
    workspacePath: cfg.workspacePath,
  }
  if (bound) {
    payload.convId = bound.convId
    payload.senderCid = bound.senderCid
    return payload
  }
  // 未绑定：优先读网关进程写入的负载文件，否则按同协议现场构造。
  const payloadText = JSON.stringify({ type: 'imnut_bind', key: bindKey, id: 2 })
  let bindPayload = payloadText
  try {
    const file = await readFile(join(cfg.workspacePath, 'bind-qrcode.txt'), 'utf8')
    const line = file.trim()
    if (line) bindPayload = line
  } catch {
    // 网关进程未运行/未写文件：用现场构造的负载，语义一致。
  }
  payload.qrcodeDataUrl = await QRCode.toDataURL(bindPayload, { width: 320, margin: 1 })
  return payload
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}
