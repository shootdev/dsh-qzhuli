# AGENTS.md

Q助理网关插件（dsh-qzhuli）—— 把 Q助理会话接入 DeepSeek Harness。

## 分层铁律（独立性是核心诉求）

- `src/gateway/` 与 `src/config.ts` **零 `@deepseek-ai/dsh-*` import**，只允许 Node 标准库
  与全局 `fetch`/`WebSocket`。任何把 Harness 类型拉进 gateway 的改动都违反仓库原则。
- `src/bridge/` 是**唯一**允许 import `dsh-*` 的地方。禁止 import 任何
  `deepseek-harness/packages/*/src` 内部模块（只许走包级 `@deepseek-ai/dsh-*` 入口）。
- 方向固定：bridge 依赖 gateway，gateway 不得依赖 bridge。
- peerDependencies 只写主版本范围，不锁 patch；`.npmrc` 关闭 auto-install-peers（peer 包由
  宿主 Harness workspace 提供，安装期不解析）。

## 命令

```sh
export PATH="$HOME/.local/share/node/bin:$PATH"   # node >= 24.9；pnpm 用 corepack
corepack pnpm install
corepack pnpm gen:paths     # 从 HARNESS_REPO（默认 ../deepseek-harness）生成 dev 映射
corepack pnpm typecheck     # 严格（gateway/config）+ 对 Harness 源码（bridge/tests）
corepack pnpm test          # vitest；gateway 改动必须带测试并全绿
corepack pnpm build         # 只构建零依赖 gateway 层到 lib/
```

`tsconfig.dev.json` 与 `vitest.alias.mjs` 是生成物（gitignore），改动生成逻辑在
`scripts/gen-tsconfig-paths.mjs`，改后必须重新 `gen:paths` 并跑 `typecheck`。

## 协议事实来源

imnut 协议的唯一权威源是 Hermes-Agent `plugins/qzhuli/adapter.py`。改动协议层前先重读它，
不要凭 README 摘要猜测（摘要可能丢细节）。

## Harness 升级流程

1. 读 Harness 仓库 `docs/upgrade-guide/<version>/` 中涉及 agent/session/llm/credentials 的部分。
2. `pnpm gen:paths && pnpm typecheck`。
3. 若 bridge 报错：只改 `src/bridge/` 与 `src/index.ts`（含 inject 列表、声明合并、peerDeps
   主版本范围）。gateway 层不应因此改动。
4. 行为/类型变化涉及测试时同步更新 `tests/bridge/`。

## 测试纪律

- gateway 每个协议行为（绑定/心跳/重连/推送/帧解析）都有对应单测，改动必须补测。
- bridge 测试用 fake ctx（测试内 `as unknown as Context`），运行时只经 vitest alias 解析
  `dsh-brand` 等少量真实包；不要把整个 Harness 运行时拉进单测。
- 断言失败先查是「测试预期错」还是「实现错」，别为了绿而改实现绕过。
