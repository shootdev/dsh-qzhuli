/**
 * 领域层端口：Q助理网关对外（适配层）的最小契约。
 * 本目录（src/gateway）零 DeepSeek Harness 依赖 —— 只依赖 Node 标准库与全局 fetch/WebSocket。
 */
/** imnut `inbound_message` 帧解析后的领域对象。 */
interface InboundMessage {
  /** 服务端消息 id（可用于日志/幂等）。 */
  readonly messageId: string;
  /** 会话 id。 */
  readonly convId: string;
  /** 发送者 cid（绑定会话中即绑定用户的 cid，不要当作“自己回显”过滤）。 */
  readonly senderCid: string;
  /** 文本内容。 */
  readonly content: string;
  /** imnut msg_type；1 = 文本（LobsterAI 实测值）。 */
  readonly msgType: number;
  /** 服务端时间戳（毫秒）。 */
  readonly ts?: number;
}
/** 出站消息发送结果。 */
interface SendResult {
  readonly success: boolean;
  readonly error?: string;
  readonly messageId?: string;
}
/** 绑定状态。 */
type BindStatus = 'unbound' | 'pending' | 'bound' | 'timeout' | 'error';
/** 扫码绑定成功后的会话凭据。 */
interface BoundSession {
  readonly convId: string;
  readonly senderCid: string;
  readonly wsToken: string;
}
/** 网关状态快照（供日志与状态展示）。 */
interface GatewayStatus {
  readonly bindStatus: BindStatus;
  readonly connected: boolean;
  readonly error?: string;
}
/** Q助理网关通道：协议层实现，适配层消费。 */
interface QzhuliChannel {
  /** 启动通道：已绑定 → 直连 WS；仅持有 bindKey → 后台扫码绑定轮询。 */
  start(): Promise<void>;
  /** 停止通道：关闭 WS、取消绑定轮询。 */
  stop(): Promise<void>;
  /** 注册入站消息处理器（最后一次调用生效）。 */
  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void;
  /** 绑定成功回调（适配层据此持久化凭据，重启后免扫码）。 */
  onBound?(handler: (session: BoundSession) => void): void;
  /** 向指定会话推送一条文本消息（role=0 Assistant）。 */
  send(convId: string, text: string): Promise<SendResult>;
}
/**
 * imnut 协议常量、URL 构造与心跳帧。
 * 全部数值来自 Hermes-Agent plugins/qzhuli 的实测实现（LobsterAI）。
 */
/** Q助理环境：release = 生产，dev = 测试。 */
type QzhuliEnvironment = 'release' | 'dev';
/** Q助理域名表。 */
declare const QZHULI_CLIENT_HOST: Record<QzhuliEnvironment, string>;
declare const QZHULI_IM_HOST: Record<QzhuliEnvironment, string>;
declare const PROTOCOL: {
  readonly scheme: "https";
  readonly wsScheme: "wss";
  /** 扫码绑定状态轮询接口。 */
  readonly checkBindPath: "/aimachine/check_bind_status";
  /** 收消息 WebSocket。 */
  readonly wsPath: "/wss_openclaw";
  /** 发消息 HTTP 接口。 */
  readonly pushPath: "/api/v1/conversations/push_message";
  /** 绑定轮询间隔。 */
  readonly bindPollIntervalMs: 5000;
  /** 绑定超时：10 分钟未在手机端确认即放弃。 */
  readonly bindTimeoutMs: 600000;
  /** push_message 超时。 */
  readonly pushTimeoutMs: 30000;
  /** WS 断线重连指数退避区间（2s → 30s）。 */
  readonly reconnectMinMs: 2000;
  readonly reconnectMaxMs: 30000;
  /** 心跳间隔：每 30s 发一次 `{"type":"ping","ts":...}`，服务端回 pong。 */
  readonly heartbeatIntervalMs: 30000;
  /** 半开检测：超过心跳间隔的该倍数未收到任何服务端帧，强制重连。 */
  readonly staleHeartbeatMultiplier: 3;
};
/** 归一化环境名；未知值回落 release。 */
declare function resolveEnvironment(value: string | undefined | null): QzhuliEnvironment;
/** 扫码绑定状态轮询 URL。 */
declare function checkBindStatusUrl(environment: QzhuliEnvironment, bindKey: string): string;
/** WS 连接参数。 */
interface WsSessionParams {
  readonly cid: string;
  readonly token: string;
  readonly convId: string;
}
/** 收消息 WebSocket URL。 */
declare function wssOpenclawUrl(environment: QzhuliEnvironment, params: WsSessionParams): string;
/** 发消息 HTTP URL。 */
declare function pushMessageUrl(environment: QzhuliEnvironment): string;
/** 客户端心跳帧（每 30s 发送）。 */
declare function heartbeatFrame(nowMs?: number): string;
/** 收到服务端 ping / heartbeat 后的应答帧。 */
declare function pongFrame(nowMs?: number): string;
/** 会话 id 派生：同一 Q助理会话永远映射到同一个 Harness Session。零依赖。 */
/** Q助理会话 id 前缀。 */
declare const QZHULI_SESSION_PREFIX = "qzhuli:";
/** 由 Q助理 conv_id 派生确定性 Session 标识（未加品牌类型；桥接层负责 brandString）。 */
declare function convSessionId(convId: string): string;
/** 一次轮询的返回：未就绪为 undefined。 */
type BindPollResult = BoundSession | undefined;
/** 整个绑定流程的结束原因。 */
type BindRunResult = 'bound' | 'timeout' | 'cancelled';
interface BindServiceOptions {
  readonly environment: 'release' | 'dev';
  readonly bindKey: string;
  readonly pollIntervalMs?: number;
  readonly timeoutMs?: number;
  /** 可注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
}
/** 从绑定接口响应中提取凭据；status 未就绪或字段不全返回 undefined。 */
declare function parseBoundPayload(body: unknown): BindPollResult;
declare class BindService {
  private readonly environment;
  private readonly bindKey;
  private readonly pollIntervalMs;
  private readonly timeoutMs;
  private readonly fetchImpl;
  private cancelled;
  constructor(options: BindServiceOptions);
  /** 执行一次轮询。 */
  pollOnce(): Promise<BindPollResult>;
  /** 循环轮询直到 绑定成功 / 超时 / 取消。网络抖动不中断（与 Hermes 行为一致）。 */
  run(onBound: (session: BoundSession) => void): Promise<BindRunResult>;
  cancel(): void;
}
interface WsClientOptions {
  readonly url: string;
  /** 可选 Sec-WebSocket-Protocol：X-OpenClaw-Token.<value>。 */
  readonly openClawToken?: string;
  readonly heartbeatIntervalMs?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  /** 半开检测：心跳间隔倍数，超过该倍数未收到任何服务端帧则强制重连。 */
  readonly staleHeartbeatMultiplier?: number;
  /** 可注入 WebSocket 实现（测试用）。 */
  readonly WebSocketImpl?: typeof WebSocket;
}
interface WsClientEvents {
  onMessage(msg: InboundMessage): void;
  onConnected(): void;
  onDisconnected(): void;
  onError(error: string): void;
}
/**
 * 解析一帧文本。
 * - 服务端 `ping` 或 `{"type":"ping"}` → 应答 pong，返回 undefined
 * - `inbound_message` → 解析为 InboundMessage
 * - 其余 → undefined
 */
declare function parseFrame(text: string, send: (frame: string) => void): InboundMessage | undefined;
declare class WsClient {
  private readonly options;
  private readonly events;
  private readonly WebSocketImpl;
  private ws;
  private heartbeatTimer;
  private reconnectTimer;
  private reconnectDelay;
  private closed;
  /** 最近一次收到服务端帧的时间（半开检测基准）。 */
  private lastActivityAt;
  constructor(options: WsClientOptions, events: WsClientEvents);
  start(): void;
  stop(): void;
  private connect;
  private handleData;
  private startHeartbeat;
  private stopHeartbeat;
  private scheduleReconnect;
}
interface PushMessageOptions {
  readonly environment: 'release' | 'dev';
  readonly convId: string;
  readonly content: string;
  /** 0 = Assistant（默认），1 = User。 */
  readonly role?: 0 | 1;
  /** 已绑定会话的 sender_cid（可选）。 */
  readonly senderCid?: string;
  readonly timeoutMs?: number;
  /** 可注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
}
declare function pushMessage(options: PushMessageOptions): Promise<SendResult>;
interface QzhuliGatewayOptions {
  readonly environment: 'release' | 'dev';
  /** 无已绑定凭据时的绑定密钥（触发扫码绑定轮询）。 */
  readonly bindKey?: string;
  /** 每次（重）连接前调用，解析已绑定凭据（支持凭据热更新）。 */
  readonly resolveSession?: () => Promise<BoundSession | undefined>;
  /** 每次连接前调用，返回可选 OpenClaw token（WS subprotocol）。 */
  readonly resolveOpenClawToken?: () => Promise<string | undefined>;
  readonly bindPollIntervalMs?: number;
  readonly bindTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly reconnectMinMs?: number;
  readonly reconnectMaxMs?: number;
  readonly pushTimeoutMs?: number;
  /** 可注入 fetch（测试用）。 */
  readonly fetchImpl?: typeof fetch;
  /** 可注入 WebSocket 实现（测试用）。 */
  readonly WebSocketImpl?: typeof WebSocket;
  /** 状态变更回调。 */
  readonly onStatus?: (status: GatewayStatus) => void;
}
declare class QzhuliGateway implements QzhuliChannel {
  private readonly options;
  private inboundHandler;
  private boundHandler;
  private bindService;
  private ws;
  private session;
  private bindStatus;
  private connected;
  private closed;
  constructor(options: QzhuliGatewayOptions);
  get status(): GatewayStatus;
  onInbound(handler: (msg: InboundMessage) => void | Promise<void>): void;
  onBound(handler: (session: BoundSession) => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  send(convId: string, text: string): Promise<SendResult>;
  private runBind;
  private connectWs;
  private emitStatus;
}
export { BindPollResult, BindRunResult, BindService, BindServiceOptions, BindStatus, BoundSession, GatewayStatus, InboundMessage, PROTOCOL, PushMessageOptions, QZHULI_CLIENT_HOST, QZHULI_IM_HOST, QZHULI_SESSION_PREFIX, QzhuliChannel, QzhuliEnvironment, QzhuliGateway, QzhuliGatewayOptions, SendResult, WsClient, WsClientEvents, WsClientOptions, WsSessionParams, checkBindStatusUrl, convSessionId, heartbeatFrame, parseBoundPayload, parseFrame, pongFrame, pushMessage, pushMessageUrl, resolveEnvironment, wssOpenclawUrl };
//# sourceMappingURL=index.d.mts.map