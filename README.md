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
    workspacePath: /Users/you/Documents/qzhuli-workspace   # 会话工作区，必填；建议与默认工作区同目录（如 ~/Documents 下）
    environment: release                          # release / dev，缺省 release
    agentPreset: standard                         # 缺省 default
    permissionPreset: default                     # 缺省 default
    allowedUsers: [sender_cid_1]                  # 可选：sender_cid 白名单
```

首次启动：无已绑定凭据时插件**自动生成** `bindKey`（显式配置 `bindKey` > credentials
`QZHULI_BIND_KEY` > 自动生成 UUID）并持久化，把扫码负载
`{"type":"imnut_bind","key":...,"id":2}` 写入 `<workspacePath>/bind-qrcode.txt`、
打印到插件日志；在手机 Q助理 App 上完成扫码后，凭据自动写入 Harness credentials
（`QZHULI_SENDER_CID` / `QZHULI_CONV_ID` / `QZHULI_WS_TOKEN`），重启后免扫码直连。

已绑定直连（或想用环境变量覆盖绑定状态）时，以下凭据经 Harness credentials 子系统解析：

| 环境变量 | 说明 |
|---|---|
| `QZHULI_SENDER_CID` | 绑定用户 cid（必填，直连时） |
| `QZHULI_CONV_ID` | 绑定会话 id（必填，直连时） |
| `QZHULI_WS_TOKEN` | WS 绑定 token（必填，直连时） |
| `QZHULI_OPENCLAW_TOKEN` | 可选：WS subprotocol `X-OpenClaw-Token.<value>` |

### Harness profile 配置要求（实测，base-only profile）

插件可以跑在只挂 `@deepseek-ai/dsh-base` 的 profile 上，但 base 不提供 agent
装配与系统提示，**必须**在 profile patch 里补齐（否则消息进得来、agent 回合不启动）：

```yaml
# bundles: ["@deepseek-ai/dsh-base"]
- insert:
    # base 之上显式补 agent 预设：registry + 一个 preset（plugins 可为空，随宿主能力跑）
    - id: agent-preset-registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config:
        default: standard
    - id: preset-standard
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: standard
        order: 1
        plugins: []
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'

    # 【关键】base 的 system-prompt 默认 personaPrefix 为空，agent 没有系统提示
    # 回合不会启动（followup 挂起、无 LLM 调用）。与 headless/web 一致显式给出：
    - id: system-prompt
      name: '@deepseek-ai/dsh-system-prompt'
      config:
        personaPrefix: >-
          You are a coding agent powered by the {{model}} model.

    # LLM：复用 web profile 的火山引擎 provider（凭据走全局 credentials refs，
    # 无需在 profile 里写密钥）
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          volcengine:
            displayName: 火山引擎
            apiKeyEnv: VOLCENGINE_API_KEY
            api: openai-completions
            baseURL: https://ark.cn-beijing.volces.com/api/coding/v3
            models:
              - id: deepseek-v4-1-flash-261017
                name: deepseek-v4-1-flash
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
      config:
        provider: volcengine
        model: deepseek-v4-1-flash-261017

    # 插件本身
    - id: qzhuli
      name: '/Users/you/myProject/dsh-qzhuli/src/index.ts'
      config:
        workspacePath: /Users/you/Documents/qzhuli-workspace
        environment: release
        agentPreset: standard
```

**workspacePath 位置**：按偏好放置——可放宿主项目目录内（如
`~/myProject/<host-project>/qzhuli-workspace`）或 `~/Documents/` 下，勿直接建在
用户主目录根。会话目录名按 workspace 路径派生，路径一旦迁移，历史会话需一并
迁移（改名 sessions 目录会导致 header cwd 校验失败，只能弃旧重建）。注意：
放在宿主项目仓库内时，agent 会把该仓库当作工作项目（AGENTS.md 等会注入会话上下文）。

**与网页端（web 进程）的会话锁隔离（必须配置）**：Harness 对同一会话使用
跨进程单写锁（`session.lock` flock，`session-persistence-jsonl` 的 lease 机制）。
web 进程启动会自动恢复其会话目录下的会话并持有写锁；若网关与 web 共用同一
`~/.dsh/sessions`，web 端会把 Q助理会话锁住，网关 `resume`/`create` 拿不到写
所有权 → 消息进得来、agent 回合起不来、无回复。**网关 profile 必须把
`session-persistence-jsonl` 的 `root` 覆盖为独立目录**（如 `~/.dsh-qzhuli/sessions`），
与 web 端物理隔离，两端可同时运行：

```yaml
- id: session-persistence-jsonl
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /Users/you/.dsh-qzhuli/sessions   # 网关专属会话目录，勿与 ~/.dsh/sessions 共用
```

已有会话迁入新 root 后，删除旧 `session.lock`（web 端 fd 锁的是旧 inode，
删除后孤儿锁失效，网关下次 open 会拿到全新 inode 的锁）。

接入实测要点：

- **system-prompt 是必配项**：空 `personaPrefix` 时 agent 回合卡死，症状是消息收到、
  会话创建、但无 LLM 调用、无回复。
- **permissionPreset 默认 `workspace-write`**：base bundle 只提供 `read-only` /
  `workspace-write` / `danger-full-access`，`'default'` 不存在——设成它会在
  create 会话时抛 `unknown preset "default"`，症状是消息进来、会话只有 header、
  回合不启动（resume 旧会话可绕过，但首次消息必现）。
- **火山引擎密钥**：`VOLCENGINE_API_KEY` 放在全局 `~/.dsh/.credentials.yaml` 的
  `refs`，profile 只声明 `apiKeyEnv`，多 profile 共用一份密钥。
- **绑定凭据持久化**：扫码后三个 `QZHULI_*` 键写入同一 credentials 文件，
  与 `VOLCENGINE_API_KEY` 并存；重启免扫码。
- **入站 `msg_type`**：服务端只推送文本且实际下发 `msg_type=0`（imnut
  `MsgType_Text=0`；`1` 是 push 侧取值），插件兼容 0/1 均按文本处理。

## 网页端绑定页（可选：扫码可视化）

网关进程之外的 `status-only` 模式 + 浏览器端 tab，让扫码绑定不依赖进程日志：

- **`mode: 'gateway'`（默认）**：完整网关（WS 收消息 + agent 推理 + 推回），如上一节。
- **`mode: 'status-only'`**：不连 WS、不启用 bridge、不注册工作区，只挂只读 API
  `GET /api/qzhuli/bind-status`（走 webServer + connection 认证），供浏览器轮询。

浏览器端在 **左侧导航「插件」页**（plugin-manager 的 `plugins.tab` slot）注册
**Q助理** tab：轮询绑定状态，未绑定时直接展示扫码二维码 + 绑定密钥，已绑定后展示
会话 ID / 用户 CID / 工作区路径。client bundle 仅 external `react` /
`react/jsx-runtime`，不 import 任何 Harness 内部模块。

在 web profile（或任意同时挂 webServer 的 profile）里挂载 status-only 条目：

```yaml
- id: qzhuli-web
  name: '/Users/you/myProject/dsh-qzhuli/src/index.ts'
  config:
    mode: status-only
    workspacePath: /Users/you/Documents/qzhuli-workspace
```

浏览器打开 Harness 网页端 → 左侧导航「插件」→ Q助理 tab。重启 web 进程后生效；
client bundle 有改动时先 `pnpm build:client` 再重启。

## 配置项

| 字段 | 类型 | 缺省 | 说明 |
|---|---|---|---|
| `mode` | `gateway` \| `status-only` | `gateway` | 完整网关 / 只读绑定状态 API |
| `workspacePath` | string（必填） | — | 会话工作区绝对路径 |
| `environment` | `release` \| `dev` | `release` | 生产 / 测试域名 |
| `agentPreset` | string | `default` | 会话 agent 预设名（与宿主 profile 对齐） |
| `permissionPreset` | string | `default` | 会话权限预设名 |
| `title` | string | `Q助理 <conv_id>` | 会话标题 |
| `allowedUsers` | string[] | 无 | sender_cid 白名单；缺省仅处理绑定会话 |
| `model` | `{provider, model, maxTokens?}` | 缺省取 `agentDefaultModel` | 显式模型路由 |
| `maxMessageLength` | number | `2000` | 入站消息截断长度 |
| `bindKey` | string | 无 | 显式绑定密钥；缺省自动生成 UUID 并持久化到 credentials |

## 行为语义

- **会话映射**：`SessionId = qzhuli:<conv_id>`（brandString 标记）。确定性派生，重启后按
  conv_id 自动 `resume` 恢复，无需映射表。
- **每会话串行队列**：同一 conv 的消息按到达顺序排队处理，避免 followup 回合交错。
- **回复读取**：回合开始前记 `sessionQuery.listEvents` 游标，`agent.whenIdle()` 结束后增量读
  最后一个 `assistant/message`，渲染 text 块推回；不维护自己的历史状态（会话日志即唯一事实源）。
- **入站过滤**：非文本消息忽略（服务端只推文本，`msg_type` 0/1 均视为文本）；非绑定 conv
  消息忽略（v1 单绑定会话）；白名单外 sender 忽略。
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
corepack pnpm build:client                        # 构建浏览器端 bundle 到 lib/client.js（改 src/client 后必跑）
```

`HARNESS_REPO` 环境变量可覆盖 Harness 仓库路径（默认 `../deepseek-harness`）。

## 开机自启与守护（macOS launchd）

独立网关用 launchd 守护，登录自动启动、崩溃自动拉起（KeepAlive）。配置了两处：

1. **包装 App**（决定「系统设置 → 通用 → 登录项 → 允许在后台」的显示名）：
   `~/Library/Application Support/QZhuliGW/Q助理-DeepSeek harness连接组件.app`
   —— 内含 Info.plist（CFBundleName=「Q助理-DeepSeek harness连接组件」）与 `Contents/MacOS/`
   同名可执行脚本（`export PATH/HOME` → `cd harness` → `exec node --import tsx/loader.mjs
   apps/cli/src/bin.ts --profile qzhuli`）。
   > macOS 后台项显示名跟随**主程序二进制名**（node 自带显示 "Node.js Foundation"），
   > 与 launchd Label 无关；因此用包装 App + 中文可执行文件名来控制显示名。

2. **LaunchAgent**：`~/Library/LaunchAgents/Q助理-DeepSeek harness连接组件.plist`
   （`RunAtLoad` + `KeepAlive`，ProgramArguments 指向包装 App 的可执行脚本；
   日志 stdout=/tmp/qzhuli-gw.log、stderr=/tmp/qzhuli-gw.err.log）。

管理命令：

```bash
launchctl print gui/501/"Q助理-DeepSeek harness连接组件"                        # 状态
launchctl bootout gui/501/"Q助理-DeepSeek harness连接组件"                       # 停止
launchctl bootstrap gui/501 ~/Library/LaunchAgents/Q助理-DeepSeek\ harness连接组件.plist  # 启动
```

生命周期通知：网关 WS 每（重）连成功向绑定会话推送「网关已开启」；进程优雅关闭前
（SIGTERM/SIGINT，经 harness 的 5s dispose 窗口）推送「网关即将关闭」。HTTP 推送
不依赖 WS，未绑定/失败静默容忍。崩溃（如 kill -9）无法触发关闭通知，属预期。

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
