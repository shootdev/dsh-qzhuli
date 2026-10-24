import { n as convSessionId, r as QzhuliGateway } from "./ids-B2FDNm5h.mjs";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { createUserMessage, errorChain } from "@deepseek-ai/dsh-llm";
import { brandString } from "@deepseek-ai/dsh-brand";
import QRCode from "qrcode";
// src/config.ts
/**
* 插件配置：只承载非密钥字段。
* 密钥与绑定凭据一律走 Harness credentials 子系统（环境变量 QZHULI_*，见 bridge/index.ts）。
*/
/** 校验并归一化配置；非法输入抛 TypeError（插件加载即失败，符合 fail-loud 约定）。 */
function validateConfig(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) throw new TypeError("qzhuli config must be an object");
	const record = input;
	const workspacePath = record.workspacePath;
	if (typeof workspacePath !== "string" || workspacePath.trim() === "") throw new TypeError("qzhuli config workspacePath must be a non-empty absolute path");
	if (!isAbsolute(workspacePath)) throw new TypeError(`qzhuli config workspacePath must be absolute, got ${JSON.stringify(workspacePath)}`);
	const environment = record.environment;
	if (environment !== void 0 && environment !== "release" && environment !== "dev") throw new TypeError(`qzhuli config environment must be 'release' or 'dev', got ${JSON.stringify(environment)}`);
	const mode = record.mode;
	if (mode !== void 0 && mode !== "gateway" && mode !== "status-only") throw new TypeError(`qzhuli config mode must be 'gateway' or 'status-only', got ${JSON.stringify(mode)}`);
	const maxMessageLength = record.maxMessageLength;
	if (maxMessageLength !== void 0 && (typeof maxMessageLength !== "number" || !Number.isSafeInteger(maxMessageLength) || maxMessageLength <= 0)) throw new TypeError("qzhuli config maxMessageLength must be a positive safe integer");
	const allowedUsers = record.allowedUsers;
	if (allowedUsers !== void 0 && (!Array.isArray(allowedUsers) || allowedUsers.some((user) => typeof user !== "string" || user === ""))) throw new TypeError("qzhuli config allowedUsers must be an array of non-empty strings");
	const model = validateModel(record.model);
	let cfg = { workspacePath };
	if (environment !== void 0) cfg = {
		...cfg,
		environment
	};
	if (mode !== void 0) cfg = {
		...cfg,
		mode
	};
	if (typeof record.agentPreset === "string" && record.agentPreset.trim() !== "") cfg = {
		...cfg,
		agentPreset: record.agentPreset.trim()
	};
	if (typeof record.permissionPreset === "string" && record.permissionPreset.trim() !== "") cfg = {
		...cfg,
		permissionPreset: record.permissionPreset.trim()
	};
	if (typeof record.title === "string" && record.title.trim() !== "") cfg = {
		...cfg,
		title: record.title.trim()
	};
	if (allowedUsers !== void 0) cfg = {
		...cfg,
		allowedUsers: [...allowedUsers]
	};
	if (model !== void 0) cfg = {
		...cfg,
		model
	};
	if (maxMessageLength !== void 0) cfg = {
		...cfg,
		maxMessageLength
	};
	if (typeof record.bindKey === "string" && record.bindKey.trim() !== "") cfg = {
		...cfg,
		bindKey: record.bindKey.trim()
	};
	return cfg;
}
function validateModel(input) {
	if (input === void 0 || input === null) return void 0;
	if (typeof input !== "object" || Array.isArray(input)) throw new TypeError("qzhuli config model must be an object { provider, model, maxTokens? }");
	const record = input;
	const provider = record.provider;
	const model = record.model;
	if (typeof provider !== "string" || provider.trim() === "" || typeof model !== "string" || model.trim() === "") throw new TypeError("qzhuli config model.provider and model.model must be non-empty strings");
	const maxTokens = record.maxTokens;
	if (maxTokens !== void 0 && (typeof maxTokens !== "number" || !Number.isSafeInteger(maxTokens) || maxTokens <= 0)) throw new TypeError("qzhuli config model.maxTokens must be a positive safe integer");
	let result = {
		provider: provider.trim(),
		model: model.trim()
	};
	if (maxTokens !== void 0) result = {
		...result,
		maxTokens
	};
	return result;
}
// src/bridge/sessions.ts
/** 本插件创建/恢复并持有的 Agent 句柄（插件停止时统一 dispose）。 */
const ownedHandles = /* @__PURE__ */ new Map();
/** 由 Q助理 conv_id 派生 Harness SessionId（确定性，重启后自动恢复同一会话）。 */
function sessionIdForConv(convId) {
	return brandString(convSessionId(convId));
}
/** 释放本插件持有的全部 Agent。 */
async function disposeOwnedAgents() {
	const handles = [...ownedHandles.values()];
	ownedHandles.clear();
	await Promise.allSettled(handles.map((handle) => handle.dispose()));
}
/**
* 确保目标会话存在一个 live Agent：优先复用 ctx.agents.get，其次 resume，最后 create。
* resume 失败且为「持久化中不存在」时走 create；其余失败直接上抛（fail loud）。
*/
async function ensureAgent(ctx, convId, cfg) {
	const sessionId = sessionIdForConv(convId);
	const live = ctx.agents.get(sessionId);
	if (live) return live;
	const presetName = cfg.agentPreset ?? "default";
	const permissionPreset = cfg.permissionPreset ?? "workspace-write";
	const preset = await ctx.agentPresets.resolve(presetName);
	await using presetScope = await ctx.agentPresets.acquireScope(preset.id);
	const agentOptions = cfg.model ?? { ...ctx.agentDefaultModel.currentSelection() };
	const setup = async (agentCtx) => {
		await ctx.agentPresets.mount(agentCtx, preset.id);
	};
	try {
		const handle = await ctx.agents.resume({
			resumeSessionId: sessionId,
			agentOptions,
			setup
		});
		ownedHandles.set(sessionId, handle);
		return handle.agent;
	} catch {}
	const handle = await createAgent(ctx, sessionId, convId, cfg, presetName, permissionPreset, agentOptions, setup);
	ownedHandles.set(sessionId, handle);
	return handle.agent;
}
async function createAgent(ctx, sessionId, convId, cfg, presetName, permissionPreset, agentOptions, setup) {
	const workspace = await ctx.workspaceRegistry.create(cfg.workspacePath);
	const handle = await ctx.agents.create({
		sessionId,
		meta: {
			cwd: workspace.path,
			agentPreset: presetName
		},
		agentOptions,
		setup
	});
	try {
		await workspace.attachSession(sessionId);
		ctx.permissionPresets.set(handle.agent.session, permissionPreset);
		ctx.sessionTitle.rename(handle.agent.session, cfg.title ?? `Q助理 ${convId}`);
	} catch (error) {
		await handle.dispose();
		throw error;
	}
	return handle;
}
// src/bridge/reply.ts
/** 把 assistant 消息内容渲染为纯文本（text 块按行拼接；reasoning/图像等块忽略）。 */
function renderTextBlocks(message) {
	return message.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
}
/** 会话当前最新事件 seq（无事件时 0）。作为「回合开始前游标」。 */
async function currentSeq(ctx, sessionId) {
	const records = await ctx.sessionQuery.listEvents(sessionId);
	const last = records[records.length - 1];
	return last ? last.seq : 0;
}
/** 读取游标之后最后一个 assistant/message 事件并渲染文本。 */
async function readLastAssistantReply(ctx, sessionId, afterSeq) {
	const candidates = (await ctx.sessionQuery.listEvents(sessionId)).filter((record) => record.seq > afterSeq && record.type === "assistant/message");
	const last = candidates[candidates.length - 1];
	if (!last) return {
		text: "",
		interrupted: false
	};
	const event = (await ctx.sessionQuery.readEvent({
		sessionId,
		seq: last.seq,
		before: 0,
		after: 0
	})).target;
	if (event.type !== "assistant/message") return {
		text: "",
		interrupted: false
	};
	return {
		text: renderTextBlocks(event.data.message),
		interrupted: event.data.interrupted === true
	};
}
// src/index.ts
/**
* Q助理网关插件入口：装配协议层（src/gateway）与 Harness 适配层（src/bridge）。
*
* 依赖面（运行时 import）：
*   - @deepseek-ai/cordis（Context）、@deepseek-ai/dsh-brand（brandString）
*   - @deepseek-ai/dsh-credentials（credentialRef）、@deepseek-ai/dsh-llm（createUserMessage/errorChain）
* 其余均为类型级依赖（声明合并/仅类型）。
*/
const name = "qzhuli";
const inject = [
	"agents",
	"agentDefaultModel",
	"agentPresets",
	"permissionPresets",
	"sessionTitle",
	"sessionQuery",
	"workspaceRegistry",
	"credentials",
	"sessionPersistence"
];
/** 绑定/密钥相关环境变量名（经 Harness credentials 子系统解析）。 */
const ENV_BIND_KEY = "QZHULI_BIND_KEY";
const ENV_SENDER_CID = "QZHULI_SENDER_CID";
const ENV_CONV_ID = "QZHULI_CONV_ID";
const ENV_WS_TOKEN = "QZHULI_WS_TOKEN";
const ENV_OPENCLAW_TOKEN = "QZHULI_OPENCLAW_TOKEN";
function apply(ctx, config) {
	const cfg = validateConfig(config);
	if ((cfg.mode ?? "gateway") === "status-only") {
		setupStatusOnly(ctx, cfg);
		return;
	}
	let gateway;
	ctx.effect(() => async () => {
		await gateway?.stop();
		await disposeOwnedAgents();
	});
	(async () => {
		const bindKey = await resolveBindKey(ctx, cfg);
		gateway = new QzhuliGateway({
			environment: cfg.environment ?? "release",
			...bindKey ? { bindKey } : {},
			resolveSession: () => resolveBoundSession(ctx),
			resolveOpenClawToken: async () => (await ctx.credentials.resolve(credentialRef(ENV_OPENCLAW_TOKEN)))?.value,
			onStatus: (status) => {
				ctx.logger.info(`qzhuli: bind=${status.bindStatus} connected=${status.connected}${status.error ? ` error=${status.error}` : ""}`);
			}
		});
		gateway.onBound((session) => {
			persistBoundSession(ctx, session);
		});
		gateway.onInbound((msg) => {
			enqueue(ctx, gateway, cfg, msg);
		});
		if (bindKey && !await resolveBoundSession(ctx)) await exposeBindQrCode(ctx, cfg, bindKey);
		await gateway.start();
	})().catch((error) => {
		ctx.logger.error(`qzhuli: gateway start failed: ${errorChain(error)}`);
	});
}
/** 解析绑定密钥：显式配置 → credentials 持久值 → 自动生成并持久化（重启后不变）。 */
async function resolveBindKey(ctx, cfg) {
	if (cfg.bindKey) return cfg.bindKey;
	const existing = await ctx.credentials.resolve(credentialRef(ENV_BIND_KEY));
	if (existing) return existing.value;
	const generated = randomUUID();
	await ctx.credentials.set(credentialRef(ENV_BIND_KEY), generated);
	ctx.logger.info("qzhuli: generated bind key and persisted (QZHULI_BIND_KEY)");
	return generated;
}
/** 把扫码绑定负载写入工作区并打日志（与 Hermes 协议一致：{"type":"imnut_bind","key":...,"id":2}）。 */
async function exposeBindQrCode(ctx, cfg, bindKey) {
	const payload = JSON.stringify({
		type: "imnut_bind",
		key: bindKey,
		id: 2
	});
	try {
		await writeFile(join(cfg.workspacePath, "bind-qrcode.txt"), `${payload}\n`, "utf8");
	} catch (error) {
		ctx.logger.warn(`qzhuli: write bind-qrcode.txt failed: ${errorChain(error)}`);
	}
	ctx.logger.info(`qzhuli: 请用手机 Q助理 App 扫码绑定 → ${payload}`);
}
/** 每会话串行队列：避免 followup 回合交错。 */
const queues = /* @__PURE__ */ new Map();
function enqueue(ctx, gateway, cfg, msg) {
	const next = (queues.get(msg.convId) ?? Promise.resolve()).then(() => processMessage(ctx, gateway, cfg, msg)).catch((error) => {
		ctx.logger.warn(`qzhuli: conv ${msg.convId} turn failed: ${errorChain(error)}`);
	});
	queues.set(msg.convId, next);
	next.finally(() => {
		if (queues.get(msg.convId) === next) queues.delete(msg.convId);
	});
}
async function processMessage(ctx, gateway, cfg, msg) {
	if (msg.msgType !== 0 && msg.msgType !== 1) {
		ctx.logger.info(`qzhuli: ignore non-text message msg_type=${msg.msgType} conv=${msg.convId}`);
		return;
	}
	const bound = await resolveBoundSession(ctx);
	if (bound && bound.convId !== msg.convId) {
		ctx.logger.warn(`qzhuli: ignore message from non-bound conv ${msg.convId}`);
		return;
	}
	if (cfg.allowedUsers?.length && !cfg.allowedUsers.includes(msg.senderCid)) {
		ctx.logger.warn(`qzhuli: ignore message from non-allowed sender ${msg.senderCid}`);
		return;
	}
	const content = msg.content.slice(0, cfg.maxMessageLength ?? 2e3);
	const sessionId = sessionIdForConv(msg.convId);
	const agent = await ensureAgent(ctx, msg.convId, cfg);
	const before = await currentSeq(ctx, sessionId);
	const userMessage = createUserMessage({
		content: [{
			type: "text",
			text: content
		}],
		source: {
			kind: "qzhuli",
			convId: msg.convId,
			senderCid: msg.senderCid,
			messageId: msg.messageId
		}
	});
	agent.followup(userMessage);
	await agent.whenIdle();
	const reply = await readLastAssistantReply(ctx, sessionId, before);
	const text = reply.text.trim();
	if (text) {
		const result = await gateway.send(msg.convId, text);
		if (!result.success) ctx.logger.warn(`qzhuli: push failed: ${result.error ?? "unknown"}`);
	} else if (reply.interrupted) ctx.logger.info(`qzhuli: conv ${msg.convId} reply empty after interruption`);
}
/** 解析已绑定凭据（每次连接/入站现解析，支持热更新）。 */
async function resolveBoundSession(ctx) {
	const [senderCid, convId, wsToken] = await Promise.all([
		ctx.credentials.resolve(credentialRef(ENV_SENDER_CID)),
		ctx.credentials.resolve(credentialRef(ENV_CONV_ID)),
		ctx.credentials.resolve(credentialRef(ENV_WS_TOKEN))
	]);
	if (senderCid && convId && wsToken) return {
		convId: convId.value,
		senderCid: senderCid.value,
		wsToken: wsToken.value
	};
}
/** 绑定成功后把凭据写入 Harness credentials（幂等），重启免扫码。 */
async function persistBoundSession(ctx, session) {
	try {
		await Promise.all([
			ctx.credentials.set(credentialRef(ENV_SENDER_CID), session.senderCid),
			ctx.credentials.set(credentialRef(ENV_CONV_ID), session.convId),
			ctx.credentials.set(credentialRef(ENV_WS_TOKEN), session.wsToken)
		]);
		ctx.logger.info(`qzhuli: bound session persisted conv=${session.convId}`);
	} catch (error) {
		ctx.logger.warn(`qzhuli: persist bound session failed: ${errorChain(error)}`);
	}
}
/** 绑定状态 API 路径（client 设置页轮询）。 */
const BIND_STATUS_PATH = "/api/qzhuli/bind-status";
/** webServer 可选注入：status-only 模式向 web 进程注册只读绑定状态 API。 */
function setupStatusOnly(ctx, cfg) {
	ctx.inject(["webServer", "connection"], (webCtx) => {
		const carrier = webCtx;
		carrier.effect(() => carrier.webServer.register({
			kind: "exact",
			path: BIND_STATUS_PATH,
			handler: (req, res) => {
				handleBindStatus(carrier, cfg, req, res);
			}
		}), `qzhuli: GET ${BIND_STATUS_PATH}`);
		ctx.logger.info(`qzhuli: status-only mode — serving ${BIND_STATUS_PATH}`);
	});
}
async function handleBindStatus(ctx, cfg, req, res) {
	const rejection = Reflect.get(ctx, "connection")?.requestRejection?.(req);
	if (rejection !== void 0) {
		res.statusCode = rejection;
		res.end();
		return;
	}
	try {
		sendJson(res, 200, await buildStatusPayload(ctx, cfg));
	} catch (error) {
		ctx.logger.warn(`qzhuli: bind-status failed: ${errorChain(error)}`);
		sendJson(res, 500, { error: errorChain(error) });
	}
}
/** 组装绑定状态：bound（凭据直连）+ bindKey（自动生成/持久化）+ 未绑定二维码。 */
async function buildStatusPayload(ctx, cfg) {
	const bound = await resolveBoundSession(ctx);
	const bindKey = await resolveBindKey(ctx, cfg);
	const payload = {
		bound: bound !== void 0,
		...bindKey === void 0 ? {} : { bindKey },
		workspacePath: cfg.workspacePath
	};
	if (bound) {
		payload.convId = bound.convId;
		payload.senderCid = bound.senderCid;
		return payload;
	}
	let bindPayload = JSON.stringify({
		type: "imnut_bind",
		key: bindKey,
		id: 2
	});
	try {
		const line = (await readFile(join(cfg.workspacePath, "bind-qrcode.txt"), "utf8")).trim();
		if (line) bindPayload = line;
	} catch {}
	payload.qrcodeDataUrl = await QRCode.toDataURL(bindPayload, {
		width: 320,
		margin: 1
	});
	return payload;
}
function sendJson(res, status, body) {
	res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
	res.end(JSON.stringify(body));
}
export { BIND_STATUS_PATH, apply, inject, name };

//# sourceMappingURL=index.mjs.map