// src/gateway/protocol.ts
/** Q助理域名表。 */
const QZHULI_CLIENT_HOST = {
	release: "client.qzhuli.com",
	dev: "test.client.qzhuli.com"
};
const QZHULI_IM_HOST = {
	release: "im.qzhuli.com",
	dev: "test.im.qzhuli.com"
};
const PROTOCOL = {
	scheme: "https",
	wsScheme: "wss",
	/** 扫码绑定状态轮询接口。 */
	checkBindPath: "/aimachine/check_bind_status",
	/** 收消息 WebSocket。 */
	wsPath: "/wss_openclaw",
	/** 发消息 HTTP 接口。 */
	pushPath: "/api/v1/conversations/push_message",
	/** 绑定轮询间隔。 */
	bindPollIntervalMs: 5e3,
	/** 绑定超时：10 分钟未在手机端确认即放弃。 */
	bindTimeoutMs: 6e5,
	/** push_message 超时。 */
	pushTimeoutMs: 3e4,
	/** WS 断线重连指数退避区间（2s → 30s）。 */
	reconnectMinMs: 2e3,
	reconnectMaxMs: 3e4,
	/** 心跳间隔：每 30s 发一次 `{"type":"ping","ts":...}`，服务端回 pong。 */
	heartbeatIntervalMs: 3e4,
	/** 半开检测：超过心跳间隔的该倍数未收到任何服务端帧，强制重连。 */
	staleHeartbeatMultiplier: 3
};
/** 归一化环境名；未知值回落 release。 */
function resolveEnvironment(value) {
	return (value ?? "release").trim().toLowerCase() === "dev" ? "dev" : "release";
}
/** 扫码绑定状态轮询 URL。 */
function checkBindStatusUrl(environment, bindKey) {
	return `${PROTOCOL.scheme}://${QZHULI_CLIENT_HOST[environment]}${PROTOCOL.checkBindPath}?bind_key=${encodeURIComponent(bindKey)}`;
}
/** 收消息 WebSocket URL。 */
function wssOpenclawUrl(environment, params) {
	const qs = new URLSearchParams({
		cid: params.cid,
		token: params.token,
		conv_id: params.convId
	});
	return `${PROTOCOL.wsScheme}://${QZHULI_IM_HOST[environment]}${PROTOCOL.wsPath}?${qs}`;
}
/** 发消息 HTTP URL。 */
function pushMessageUrl(environment) {
	return `${PROTOCOL.scheme}://${QZHULI_IM_HOST[environment]}${PROTOCOL.pushPath}`;
}
/** 客户端心跳帧（每 30s 发送）。 */
function heartbeatFrame(nowMs = Date.now()) {
	return JSON.stringify({
		type: "ping",
		ts: nowMs
	});
}
/** 收到服务端 ping / heartbeat 后的应答帧。 */
function pongFrame(nowMs = Date.now()) {
	return JSON.stringify({
		type: "pong",
		ts: nowMs
	});
}
// src/gateway/bind.ts
/**
* 扫码绑定轮询：按固定间隔轮询 check_bind_status，直至 status=1（或 "bound"），
* 返回会话凭据（conv_id / cid / bind_token）。
*/
/** 从绑定接口响应中提取凭据；status 未就绪或字段不全返回 undefined。 */
function parseBoundPayload(body) {
	if (typeof body !== "object" || body === null) return void 0;
	const record = body;
	const payload = typeof record.data === "object" && record.data !== null ? record.data : record;
	const status = String(payload.status ?? "").toLowerCase();
	if (status !== "1" && status !== "bound") return void 0;
	const convId = String(payload.conversation_id ?? payload.conv_id ?? "").trim();
	const senderCid = String(payload.cid ?? "").trim();
	const wsToken = String(payload.bind_token ?? payload.token ?? "").trim();
	if (!convId || !senderCid || !wsToken) return void 0;
	return {
		convId,
		senderCid,
		wsToken
	};
}
var BindService = class {
	environment;
	bindKey;
	pollIntervalMs;
	timeoutMs;
	fetchImpl;
	cancelled = false;
	constructor(options) {
		this.environment = options.environment;
		this.bindKey = options.bindKey;
		this.pollIntervalMs = options.pollIntervalMs ?? PROTOCOL.bindPollIntervalMs;
		this.timeoutMs = options.timeoutMs ?? PROTOCOL.bindTimeoutMs;
		this.fetchImpl = options.fetchImpl ?? fetch;
	}
	/** 执行一次轮询。 */
	async pollOnce() {
		const response = await this.fetchImpl(checkBindStatusUrl(this.environment, this.bindKey), { signal: AbortSignal.timeout(1e4) });
		if (!response.ok) throw new Error(`bind status http ${response.status}`);
		return parseBoundPayload(await response.json());
	}
	/** 循环轮询直到 绑定成功 / 超时 / 取消。网络抖动不中断（与 Hermes 行为一致）。 */
	async run(onBound) {
		const deadline = Date.now() + this.timeoutMs;
		while (!this.cancelled) {
			if (Date.now() > deadline) return "timeout";
			try {
				const session = await this.pollOnce();
				if (session) {
					onBound(session);
					return "bound";
				}
			} catch {
				if (this.cancelled) return "cancelled";
			}
			await sleep(this.pollIntervalMs);
		}
		return "cancelled";
	}
	cancel() {
		this.cancelled = true;
	}
};
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
// src/gateway/push.ts
/**
* push_message HTTP 客户端：把 Agent 回复推回 Q助理。
*/
async function pushMessage(options) {
	const payload = {
		conv_id: options.convId,
		content: options.content,
		msg_type: 1,
		role: options.role ?? 0
	};
	if (options.senderCid) payload.sender_cid = options.senderCid;
	const fetchImpl = options.fetchImpl ?? fetch;
	try {
		const response = await fetchImpl(pushMessageUrl(options.environment), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(options.timeoutMs ?? PROTOCOL.pushTimeoutMs)
		});
		if (!response.ok) return {
			success: false,
			error: `push http ${response.status}`
		};
		const body = await response.json();
		const code = typeof body === "object" && body !== null ? body.code : void 0;
		if (typeof code === "number" && code !== 200) return {
			success: false,
			error: `qzhuli push error: ${typeof body === "object" && body !== null ? String(body.msg ?? code) : String(code)}`
		};
		return {
			success: true,
			messageId: String(Date.now())
		};
	} catch (error) {
		return {
			success: false,
			error: String(error)
		};
	}
}
// src/gateway/ws.ts
/**
* wss_openclaw 客户端：收消息、心跳、断线指数退避重连。
* 基于 Node 全局 WebSocket（WHATWG 实现），零第三方依赖。
*/
const WS_OPEN = 1;
/**
* 解析一帧文本。
* - 服务端 `ping` 或 `{"type":"ping"}` → 应答 pong，返回 undefined
* - `inbound_message` → 解析为 InboundMessage
* - 其余 → undefined
*/
function parseFrame(text, send) {
	const trimmed = text.trim();
	if (!trimmed) return void 0;
	if (trimmed.toLowerCase() === "ping") {
		send(pongFrame());
		return;
	}
	let frame;
	try {
		frame = JSON.parse(trimmed);
	} catch {
		return;
	}
	if (typeof frame !== "object" || frame === null) return void 0;
	const record = frame;
	const type = String(record.type ?? "").toLowerCase();
	if (type === "ping" || type === "heartbeat") {
		send(pongFrame());
		return;
	}
	if (type !== "inbound_message") return void 0;
	const payload = record.payload;
	if (typeof payload !== "object" || payload === null) return void 0;
	const convId = String(payload.conv_id ?? "").trim();
	const content = String(payload.content ?? "").trim();
	if (!convId || !content) return void 0;
	const rawId = payload.msg_id;
	const messageId = rawId === void 0 || rawId === null ? String(Date.now()) : String(rawId);
	const rawTs = payload.ts;
	return {
		messageId,
		convId,
		senderCid: String(payload.sender_cid ?? "").trim(),
		content,
		msgType: typeof payload.msg_type === "number" ? payload.msg_type : Number(payload.msg_type ?? 1),
		...rawTs === void 0 ? {} : { ts: Number(rawTs) }
	};
}
var WsClient = class {
	options;
	events;
	WebSocketImpl;
	ws;
	heartbeatTimer;
	reconnectTimer;
	reconnectDelay;
	closed = false;
	/** 最近一次收到服务端帧的时间（半开检测基准）。 */
	lastActivityAt = 0;
	constructor(options, events) {
		this.options = options;
		this.events = events;
		this.WebSocketImpl = options.WebSocketImpl ?? WebSocket;
		this.reconnectDelay = options.reconnectMinMs ?? PROTOCOL.reconnectMinMs;
	}
	start() {
		this.closed = false;
		this.connect();
	}
	stop() {
		this.closed = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = void 0;
		}
		this.stopHeartbeat();
		const ws = this.ws;
		this.ws = void 0;
		if (ws && ws.readyState === WS_OPEN) try {
			ws.close(1e3, "plugin stop");
		} catch {}
	}
	connect() {
		if (this.closed) return;
		const token = this.options.openClawToken?.trim();
		const protocols = token ? [`X-OpenClaw-Token.${token}`] : void 0;
		let ws;
		try {
			ws = protocols ? new this.WebSocketImpl(this.options.url, protocols) : new this.WebSocketImpl(this.options.url);
		} catch (error) {
			this.events.onError(String(error));
			this.scheduleReconnect();
			return;
		}
		this.ws = ws;
		ws.addEventListener("open", () => {
			this.reconnectDelay = this.options.reconnectMinMs ?? PROTOCOL.reconnectMinMs;
			this.lastActivityAt = Date.now();
			this.events.onConnected();
			this.startHeartbeat();
		});
		ws.addEventListener("message", (event) => {
			this.lastActivityAt = Date.now();
			this.handleData(event.data);
		});
		ws.addEventListener("close", () => {
			if (this.ws === ws) this.ws = void 0;
			this.stopHeartbeat();
			this.events.onDisconnected();
			this.scheduleReconnect();
		});
		ws.addEventListener("error", () => {
			this.events.onError("websocket error");
		});
	}
	async handleData(data) {
		try {
			let text;
			if (typeof data === "string") text = data;
			else if (data instanceof Blob) text = await data.text();
			else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
			else text = String(data);
			const ws = this.ws;
			const send = (frame) => {
				if (ws && ws.readyState === WS_OPEN) ws.send(frame);
			};
			const msg = parseFrame(text, send);
			if (msg) this.events.onMessage(msg);
		} catch (error) {
			this.events.onError(String(error));
		}
	}
	startHeartbeat() {
		this.stopHeartbeat();
		const interval = this.options.heartbeatIntervalMs ?? PROTOCOL.heartbeatIntervalMs;
		this.heartbeatTimer = setInterval(() => {
			const ws = this.ws;
			if (!ws || ws.readyState !== WS_OPEN) return;
			const staleAfter = (this.options.staleHeartbeatMultiplier ?? PROTOCOL.staleHeartbeatMultiplier) * interval;
			if (this.lastActivityAt > 0 && Date.now() - this.lastActivityAt > staleAfter) {
				this.stopHeartbeat();
				try {
					ws.close(4001, "stale connection: no frames");
				} catch {}
				return;
			}
			try {
				ws.send(heartbeatFrame());
			} catch {
				this.stopHeartbeat();
				try {
					ws.close(4001, "heartbeat send failed");
				} catch {}
			}
		}, interval);
	}
	stopHeartbeat() {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = void 0;
		}
	}
	scheduleReconnect() {
		if (this.closed) return;
		const delay = this.reconnectDelay;
		this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.options.reconnectMaxMs ?? PROTOCOL.reconnectMaxMs);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = void 0;
			this.connect();
		}, delay);
	}
};
// src/gateway/gateway.ts
/**
* QzhuliGateway：组合 扫码绑定轮询 + WS 收消息 + HTTP 推送，实现 QzhuliChannel。
* 本类不感知 Harness：一切与宿主交互的能力都收敛在构造参数（回调/注入）里。
*/
var QzhuliGateway = class {
	options;
	inboundHandler;
	boundHandler;
	bindService;
	ws;
	session;
	bindStatus;
	connected = false;
	closed = false;
	constructor(options) {
		this.options = options;
		this.bindStatus = options.bindKey ? "pending" : "unbound";
	}
	get status() {
		return {
			bindStatus: this.bindStatus,
			connected: this.connected
		};
	}
	onInbound(handler) {
		this.inboundHandler = handler;
	}
	onBound(handler) {
		this.boundHandler = handler;
	}
	async start() {
		this.closed = false;
		const session = await this.options.resolveSession?.();
		if (session) {
			this.session = session;
			this.bindStatus = "bound";
			this.emitStatus();
			await this.connectWs();
			return;
		}
		if (this.options.bindKey) {
			this.bindStatus = "pending";
			this.emitStatus();
			this.bindService = new BindService({
				environment: this.options.environment,
				bindKey: this.options.bindKey,
				...this.options.bindPollIntervalMs !== void 0 ? { pollIntervalMs: this.options.bindPollIntervalMs } : {},
				...this.options.bindTimeoutMs !== void 0 ? { timeoutMs: this.options.bindTimeoutMs } : {},
				...this.options.fetchImpl !== void 0 ? { fetchImpl: this.options.fetchImpl } : {}
			});
			this.runBind();
			return;
		}
		this.bindStatus = "error";
		this.emitStatus({ error: "Qzhuli 未绑定：缺少 bindKey 或已绑定凭据" });
	}
	async stop() {
		this.closed = true;
		this.bindService?.cancel();
		this.bindService = void 0;
		this.ws?.stop();
		this.ws = void 0;
		this.connected = false;
	}
	async send(convId, text) {
		return pushMessage({
			environment: this.options.environment,
			convId,
			content: text,
			role: 0,
			...this.session ? { senderCid: this.session.senderCid } : {},
			...this.options.pushTimeoutMs !== void 0 ? { timeoutMs: this.options.pushTimeoutMs } : {},
			...this.options.fetchImpl !== void 0 ? { fetchImpl: this.options.fetchImpl } : {}
		});
	}
	async runBind() {
		const service = this.bindService;
		if (!service) return;
		if (await service.run((session) => {
			this.session = session;
			this.bindStatus = "bound";
			this.emitStatus();
			this.boundHandler?.(session);
			this.connectWs();
		}) === "timeout" && !this.closed) {
			this.bindStatus = "timeout";
			this.emitStatus({ error: "Qzhuli 绑定超时（10 分钟内未在手机端确认）" });
		}
	}
	async connectWs() {
		const session = this.session;
		if (!session || this.closed) return;
		const openClawToken = await this.options.resolveOpenClawToken?.();
		const client = new WsClient({
			url: wssOpenclawUrl(this.options.environment, {
				cid: session.senderCid,
				token: session.wsToken,
				convId: session.convId
			}),
			...openClawToken !== void 0 ? { openClawToken } : {},
			...this.options.heartbeatIntervalMs !== void 0 ? { heartbeatIntervalMs: this.options.heartbeatIntervalMs } : {},
			...this.options.reconnectMinMs !== void 0 ? { reconnectMinMs: this.options.reconnectMinMs } : {},
			...this.options.reconnectMaxMs !== void 0 ? { reconnectMaxMs: this.options.reconnectMaxMs } : {},
			...this.options.WebSocketImpl !== void 0 ? { WebSocketImpl: this.options.WebSocketImpl } : {}
		}, {
			onMessage: (msg) => {
				if (this.inboundHandler) this.inboundHandler(msg);
			},
			onConnected: () => {
				this.connected = true;
				this.emitStatus();
			},
			onDisconnected: () => {
				this.connected = false;
				this.emitStatus();
			},
			onError: (error) => {
				this.emitStatus({ error });
			}
		});
		this.ws = client;
		client.start();
	}
	emitStatus(extra) {
		const status = {
			bindStatus: this.bindStatus,
			connected: this.connected,
			...extra?.error ? { error: extra.error } : {}
		};
		this.options.onStatus?.(status);
	}
};
// src/gateway/ids.ts
/** 会话 id 派生：同一 Q助理会话永远映射到同一个 Harness Session。零依赖。 */
/** Q助理会话 id 前缀。 */
const QZHULI_SESSION_PREFIX = "qzhuli:";
/** 由 Q助理 conv_id 派生确定性 Session 标识（未加品牌类型；桥接层负责 brandString）。 */
function convSessionId(convId) {
	return `${QZHULI_SESSION_PREFIX}${convId}`;
}
export { wssOpenclawUrl as _, parseFrame as a, parseBoundPayload as c, QZHULI_IM_HOST as d, checkBindStatusUrl as f, resolveEnvironment as g, pushMessageUrl as h, WsClient as i, PROTOCOL as l, pongFrame as m, convSessionId as n, pushMessage as o, heartbeatFrame as p, QzhuliGateway as r, BindService as s, QZHULI_SESSION_PREFIX as t, QZHULI_CLIENT_HOST as u };

//# sourceMappingURL=ids-B2FDNm5h.mjs.map