import { defineConfig } from 'tsdown'

/**
 * Client-bundle build：浏览器侧的 Q助理设置页（settings.plugins.tab 注册）。
 * 直接产出 web 进程可加载的 closure-factory bundle（lib/client.js）：
 *
 *   window.__ModuleLoader__.load({ id: 'dsh-qzhuli', factory: (require) => {
 *     var module = { exports: {} }; var exports = module.exports; ...
 *     return module.exports;
 *   }});
 *
 * react / react/jsx-runtime 保持 external，由 web 进程的模块表提供。
 * 与 Harness client 包 tsdown.client.ts 的 banner/intro/footer 结构同构。
 */
export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  format: 'cjs',
  external: ['react', 'react/jsx-runtime'],
  outDir: 'lib',
  clean: false,
  sourcemap: false,
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-qzhuli", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
})
