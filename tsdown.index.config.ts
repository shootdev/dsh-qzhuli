import { defineConfig } from 'tsdown'

/**
 * 服务端入口构建（lib/index.js）：网关插件本体。
 * 依赖（@deepseek-ai/*、qrcode、node:*）保持 external，由宿主 profile 的
 * node_modules 在运行时解析；产物为标准 ESM + 声明文件，供 desktop/web 等
 * 生产运行时直接加载（node_modules 下禁止 TS 类型剥离，main 必须指向 JS）。
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'gateway/index': 'src/gateway/index.ts',
  },
  format: 'esm',
  external: [/^@deepseek-ai\//, 'qrcode', /^node:/],
  dts: true,
  outDir: 'lib',
  clean: false,
  sourcemap: true,
})
