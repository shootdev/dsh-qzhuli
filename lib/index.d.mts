import { Context } from "@deepseek-ai/cordis";
declare const name = "qzhuli";
declare const inject: readonly ["agents", "agentDefaultModel", "agentPresets", "permissionPresets", "sessionTitle", "sessionQuery", "workspaceRegistry", "credentials", "sessionPersistence"];
declare function apply(ctx: Context, config: unknown): void;
/** 绑定状态 API 路径（client 设置页轮询）。 */
declare const BIND_STATUS_PATH = "/api/qzhuli/bind-status";
/** 绑定状态接口响应体。 */
interface BindStatusPayload {
  readonly bound: boolean;
  readonly bindKey?: string;
  readonly convId?: string;
  readonly senderCid?: string;
  /** 未绑定时：扫码绑定二维码 PNG dataURL（imnut_bind 负载）。 */
  readonly qrcodeDataUrl?: string;
  readonly workspacePath: string;
}
export { BIND_STATUS_PATH, BindStatusPayload, apply, inject, name };
//# sourceMappingURL=index.d.mts.map