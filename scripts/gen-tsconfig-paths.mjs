#!/usr/bin/env node
/**
 * 生成 tsconfig.dev.json（TS paths）与 vitest.alias.mjs（vite alias）：
 * 把 DeepSeek Harness 仓库自身的「包名 → 源码路径」映射复制到本插件仓库，
 * 使桥接层（src/bridge、src/index.ts）能在开发期直接对当前 Harness 源码
 * 做类型检查与运行测试 —— 不依赖 npm 上可能滞后的 @deepseek-ai/dsh-* 发布版。
 *
 * 用法：node scripts/gen-tsconfig-paths.mjs
 * 环境变量 HARNESS_REPO 可覆盖 Harness 仓库路径（默认 ../deepseek-harness）。
 */
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = process.env.HARNESS_REPO || resolve(here, '../../deepseek-harness')

/** 移除 JSONC 注释（状态机：正确处理字符串内的 // 与 /* ），并校验被剥离内容都是注释。 */
function stripJsonc(text) {
  let out = ''
  let i = 0
  let inString = false
  while (i < text.length) {
    const c = text[i]
    const next = text[i + 1]
    if (inString) {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i += 2
        continue
      }
      if (c === '"') inString = false
      i += 1
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      i += 1
      continue
    }
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) throw new Error('unterminated block comment')
      i = end + 2
      continue
    }
    out += c
    i += 1
  }
  return out
}

const basePath = join(repo, 'tsconfig.base.json')
if (!existsSync(basePath)) {
  throw new Error(`DeepSeek Harness repo not found at ${repo}（设置 HARNESS_REPO 指向仓库根目录）`)
}
const base = JSON.parse(stripJsonc(readFileSync(basePath, 'utf8')))
const paths = base.compilerOptions?.paths
if (!paths) throw new Error(`no compilerOptions.paths in ${basePath}`)

/** 值归一：目录 → index.ts（vite alias 需要文件级目标；TS paths 目录亦可）。 */
function toFileTarget(p) {
  const abs = resolve(repo, p)
  if (!/\.(ts|tsx|d\.ts|js|mjs)$/.test(abs) && existsSync(abs) && statSync(abs).isDirectory()) {
    for (const candidate of ['index.ts', 'index.tsx', 'index.d.ts', 'index.js']) {
      if (existsSync(join(abs, candidate))) return join(abs, candidate)
    }
  }
  return abs
}

const absPaths = {}
for (const [key, values] of Object.entries(paths)) {
  absPaths[key] = values.map((value) => resolve(repo, value))
}

/** 插件目录与 Harness 仓库的共同祖先（rootDir 需包含全部参与检查的源码）。 */
function commonRoot(a, b) {
  const pa = a.split('/')
  const pb = b.split('/')
  const out = []
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
    if (pa[i] !== pb[i]) break
    out.push(pa[i])
  }
  return out.join('/') || '/'
}
const pluginRoot = resolve(here, '..')

const tsconfigDev = {
  extends: './tsconfig.json',
  compilerOptions: {
    noEmit: true,
    // 开发期类型检查会拉入 Harness 仓库源码（位于本仓库 src 之外）
    rootDir: commonRoot(pluginRoot, repo),
    // 复刻 Harness 对 vendor 包的宽松编译标志（vendor/loader、vendor/schemastery
    // 等在自己的 tsconfig 里关闭了这些严格项）；本仓库自己的 gateway 层仍由
    // tsconfig.json 以全严格模式检查。
    noImplicitAny: false,
    noImplicitThis: false,
    strictFunctionTypes: false,
    noUncheckedIndexedAccess: false,
    exactOptionalPropertyTypes: false,
    noImplicitOverride: false,
    noUnusedLocals: false,
    noUnusedParameters: false,
    paths: absPaths,
  },
  include: ['src', 'tests'],
}
writeFileSync(join(here, '../tsconfig.dev.json'), JSON.stringify(tsconfigDev, null, 2) + '\n')

/** vitest alias：非通配键用字符串精确匹配；通配键（*）转正则前缀匹配。 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
const aliases = []
for (const [key, values] of Object.entries(paths)) {
  const replacement = toFileTarget(values[0])
  if (key.includes('*')) {
    const prefix = key.slice(0, key.indexOf('*'))
    const dir = replacement.slice(0, replacement.indexOf('*') >= 0 ? replacement.indexOf('*') : replacement.length)
    aliases.push({ find: new RegExp(`^${escapeRegExp(prefix)}`), replacement: dir })
  } else {
    aliases.push({ find: key, replacement })
  }
}
writeFileSync(
  join(here, '../vitest.alias.mjs'),
  `/** 由 scripts/gen-tsconfig-paths.mjs 生成，勿手改 */\nexport default ${JSON.stringify(aliases, null, 2)}\n`,
)

console.log(`tsconfig.dev.json + vitest.alias.mjs 已生成（${Object.keys(absPaths).length} 条映射，repo=${repo}）`)
