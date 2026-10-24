# dsh-qzhuli

Q助理（QZhuli）网关插件 for DeepSeek Harness —— 把 Q助理手机/电脑端会话接入 Harness Agent：
扫码绑定 → WebSocket 收消息 → 推入 Agent 回合 → 增量读取回复 → HTTP 推回 Q助理。

对齐 Hermes-Agent `plugins/qzhuli` 的 imnut 协议实测行为，但**不 fork 任何 Harness 内部代码**：
插件以独立仓库、独立版本发布，Harness 升级时通常只需重新跑一次类型检查。

## 架构：三层，依赖面收敛

```
src/gateway/   协议层（QzhuliChannel）—— 零 @deepseek-ai/dsh-* 依赖
                 port.ts      领域端口（InboundMessage / BoundSession / QzhuliChannel）
                 protocol.ts  imnut 协议常量、URL、心跳帧
                 ids.ts       确定性 SessionId 派生（qzhuli:<conv_id>）
                 bind.ts      扫码绑定轮询（5s 间隔 / 10 分钟超时）
                 ws.ts        wss_openclaw 客户端（收消息 / 心跳 / 指数退避重连 2s→30s）
                 push.ts      push_message HTTP 客户端
                 gateway.ts   QzhuliGateway：组合绑定 + WS + 推送，实现 QzhuliChannel
src/config.ts   插件配置校验（零依赖，非法配置加载即抛错）
src/bridge/    适配层 —— 唯一 import @deepseek-ai/dsh-* 的地方（<200 行）
                 source.ts    MessageSourceMap 声明合并（kind: 'qzhuli'）
                 sessions.ts  ensureAgent：live 复用 / resume 恢复 / create 新建
                 reply.ts     回合结束后增量读取 assistant/message 并渲染文本
src/index.ts    装配层：插件入口（name / inject / apply）
```

依赖面收敛到：8 个注入服务（agents / agentDefaultModel / agentPresets / permissionPresets /
sessionTitle / sessionQuery / workspaceRegistry / credentials / sessionPersistence）+
3 个运行时包 import（cordis `Context`、dsh-brand `brandString`、dsh-credentials `credentialRef`、
dsh-llm `createUserMessage`/`errorChain`）+ MessageSourceMap 声明合并。
**禁止 import 任何 `packages/*/src` 内部模块**。

## 快速接入

把插件目录（相对你的 profile 目录或绝对路径）加进 Harness 配置 patch：

```yaml
# cordis.patch.yml 或 profile 目录下的 patch 文件
- name: '/Users/you/myProject/dsh-qzhuli/src/index.ts'
  config:
    workspacePath: /Users/you/qzhuli-workspace   # 会话工作区，必填
    environment: release                          # release / dev，缺省 release
    agentPreset: default                          # 缺省 default
    permissionPreset: default                     # 缺省 default
    allowedUsers: [sender_cid_1]                  # 可选：sender_cid 白名单
    bindKey: 你的绑定密钥                          # 首次接入：无凭据时触发扫码绑定
```

首次启动：无已绑定凭据 + 有 `bindKey` → 网关进入 `pending`，在手机 Q助理 App 上完成扫码；
绑定成功后凭据自动写入 Harness credentials（`QZHULI_SENDER_CID` / `QZHULI_CONV_ID` / `QZHULI_WS_TOKEN`），
重启后免扫码直连。

已绑定直连（或想用环境变量覆盖绑定状态）时，以下凭据经 Harness credentials 子系统解析：

| 环境变量 | 说明 |
|---|---|
| `QZHULI_SENDER_CID` | 绑定用户 cid（必填，直连时） |
| `QZHULI_CONV_ID` | 绑定会话 id（必填，直连时） |
| `QZHULI_WS_TOKEN` | WS 绑定 token（必填，直连时） |
| `QZHULI_OPENCLAW_TOKEN` | 可选：WS subprotocol `X-OpenClaw-Token.<value>` |

## 配置项

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `workspacePath` | string（必填） | — | 会话工作区绝对路径 |
| `environment` | `release` \| `dev` | `release` | 生产 / 测试域名 |
| `agentPreset` | string | `default` | 会话 agent 预设名（与宿主 profile 对齐） |
| `permissionPreset` | string | `default` | 会话权限预设名 |
| `title` | string | `Q助理 <conv_id>` | 会话标题 |
| `allowedUsers` | string[] | 无 | sender_cid 白名单；缺省仅处理绑定会话 |
| `model` | `{provider, model, maxTokens?}` | 缺省取 `agentDefaultModel` | 显式模型路由 |
| `maxMessageLength` | number | `2000` | 入站消息截断长度 |
| `bindKey` | string | 无 | 无凭据时启用扫码绑定 |

## 行为语义

- **会话映射**：`SessionId = qzhuli:<conv_id>`（brandString 标记）。确定性派生，重启后按
  conv_id 自动 `resume` 恢复，无需映射表。
- **每会话串行队列**：同一 conv 的消息按到达顺序排队处理，避免 followup 回合交错。
- **回复读取**：回合开始前记 `sessionQuery.listEvents` 游标，`agent.whenIdle()` 结束后增量读
  最后一个 `assistant/message`，渲染 text 块推回；不维护自己的历史状态（会话日志即唯一事实源）。
- **入站过滤**：非文本消息忽略；非绑定 conv 消息忽略（v1 单绑定会话）；白名单外 sender 忽略。
- **凭据热更新**：每次连接/重连现解析 credentials，改环境变量无需重启插件。

## 独立性设计（核心诉求）

1. **协议层零依赖**：`src/gateway/` 只用 Node 全局 `fetch` / `WebSocket`，方向是适配层依赖协议层；
   协议层可独立构建（`lib/`）与测试，与 Harness 无关。
2. **适配层单点耦合**：`src/bridge/` 是唯一 import `dsh-*` 的地方；Harness API 变化时，
   改动通常只发生在这一个目录。
3. **peerDependencies 不锁版本**：声明主版本范围，不锁 patch；peer 包由宿主的 Harness
   workspace 提供（`.npmrc` 关闭了安装期自动解析 peer）。
4. **开发期类型检查对当前源码**：`pnpm gen:paths` 从你的 Harness 仓库 `tsconfig.base.json`
   复制包名→源码映射（`tsconfig.dev.json` + `vitest.alias.mjs`），bridge 直接对**当前**
   Harness 源码做类型检查/测试，不依赖 npm 上可能滞后的发布版。
5. **升级信号源**：关注 Harness 仓库 `docs/upgrade-guide/<version>/`；升级后跑 `pnpm typecheck`，
   若 bridge 报错即按新 API 修改 `src/bridge/`（协议层不受影响）。

## 开发

```bash
export PATH="$HOME/.local/share/node/bin:$PATH"   # node >= 24.9
corepack pnpm install                             # 只装 devDependencies（typescript/vitest/@types/node）
corepack pnpm gen:paths                           # 生成指向 Harness 源码的 dev 映射
corepack pnpm typecheck                           # 严格（gateway/config）+ 对 Harness 源码（bridge）
corepack pnpm test                                # vitest：59 个用例
corepack pnpm build                               # 仅构建零依赖的 gateway 层到 lib/
```

`HARNESS_REPO` 环境变量可覆盖 Harness 仓库路径（默认 `../deepseek-harness`）。

## 已知限制与风险

- **pre-stable API**：Harness 公共 API 现标 pre-stable，插件做不到「永不改动」；设计把改动面
  收敛到 `src/bridge/`。更彻底的独立方案是独立进程网关（ACP/HTTP），v1 不采用。
- **单绑定会话**：v1 只处理绑定会话的消息（非绑定 conv 忽略）；多会话扩展需要改
  `processMessage` 的过滤策略与绑定模型。
- **`X-OpenClaw-Token` 是否必需**：服务端是否强制该 WS subprotocol 未实测（Hermes 把它做成
  可选配置）；联调第一步应实证。
- **会话恢复**：`agents.resume` 抛出「持久化中不存在」时新建会话；其它恢复失败也会走新建
  路径（fail loud，回合会可见地失败）。
- **无消息去重**：与 Hermes 行为一致，不做 msg_id 幂等去重；断线重传可能重复入站。

## License

MIT
