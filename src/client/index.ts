/**
 * Q助理 client 半（浏览器）：在「插件」管理页注册一个 Q助理 tab，
 * 轮询 host 的绑定状态 API（/api/qzhuli/bind-status）展示：
 *  - 未绑定：扫码二维码 + 绑定密钥
 *  - 已绑定：会话信息 + 工作区路径
 *
 * 注册面：plugins.tab（ui-plugin-manager 渲染的插件页 tab）。
 * external 仅有 react / react/jsx-runtime，其余走 slots 注入。
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { QzhuliBindTab, type QzhuliBindTabInjected } from './QzhuliBindTab.tsx'

export type { QzhuliBindTabInjected, QzhuliBindTabProps } from './QzhuliBindTab.tsx'

/** Services required by the Plugins-page registration. */
export const inject = ['slots'] as const

/** Contribute the Q助理 tab to the Plugins page. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('plugins.tab', () => ctx.slots.register({
    name: 'plugins.tab',
    id: 'qzhuli',
    order: 20,
    label: () => 'Q助理',
    locale: 'qzhuli',
    inject: (): QzhuliBindTabInjected => ({}),
  }, QzhuliBindTab))
}
