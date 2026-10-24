import { defineConfig } from 'vitest/config'
import alias from './vitest.alias.mjs'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
  },
  resolve: {
    // 桥接层测试涉及的 @deepseek-ai/dsh-* 运行时导入（如 dsh-brand）
    // 解析到 Harness 仓库源码（由 scripts/gen-tsconfig-paths.mjs 生成）。
    alias,
  },
})
