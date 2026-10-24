/**
 * Q助理绑定状态设置页：轮询 host 绑定状态 API，展示二维码 / 绑定信息。
 * 纯 React + fetch，无第三方 UI 依赖；内联样式保持 client bundle 轻量。
 */

import { useEffect, useState } from 'react'

/** 与 host 半 BindStatusPayload 对应的浏览器侧类型。 */
export interface QzhuliBindStatus {
  readonly bound: boolean
  readonly bindKey?: string
  readonly convId?: string
  readonly senderCid?: string
  readonly qrcodeDataUrl?: string
  readonly workspacePath: string
}

export interface QzhuliBindTabProps {
  /** Injected props（当前无宿主注入数据；数据全部来自 host API）。 */
  injected: QzhuliBindTabInjected
}

export interface QzhuliBindTabInjected {
  /** Marker：设置页数据来自 host API，无注入面。 */
  readonly _empty?: never
}

const STATUS_URL = '/api/qzhuli/bind-status'
const POLL_MS = 5000

const styles: Record<string, React.CSSProperties> = {
  root: {
    display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0',
  },
  card: {
    border: '1px solid var(--dsh-color-border, #e5e7eb)',
    borderRadius: 8,
    padding: 16,
    display: 'flex', flexDirection: 'column', gap: 10,
  },
  title: { fontSize: 15, fontWeight: 600, margin: 0 },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  badge: {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600,
  },
  badgeOk: { background: '#e6f7ee', color: '#1a7f43' },
  badgeWait: { background: '#fef4e6', color: '#b45309' },
  qr: { width: 200, height: 200, imageRendering: 'pixelated' },
  mono: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 12, wordBreak: 'break-all',
  },
  muted: { fontSize: 12, color: 'var(--dsh-color-text-secondary, #6b7280)' },
  error: { color: '#b42318', fontSize: 13 },
}

/** 轮询 host 绑定状态。 */
async function fetchStatus(): Promise<QzhuliBindStatus> {
  const response = await fetch(STATUS_URL, { cache: 'no-store' })
  if (!response.ok) throw new Error(`bind-status HTTP ${response.status}`)
  return (await response.json()) as QzhuliBindStatus
}

export function QzhuliBindTab(_props: QzhuliBindTabProps): React.JSX.Element {
  const [status, setStatus] = useState<QzhuliBindStatus | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const poll = async (): Promise<void> => {
      try {
        const next = await fetchStatus()
        if (disposed) return
        setStatus(next)
        setError(null)
      } catch (cause) {
        if (disposed) return
        setError(cause instanceof Error ? cause.message : String(cause))
      }
      if (!disposed) timer = setTimeout(() => { void poll() }, POLL_MS)
    }
    void poll()
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (error !== null && status === null) {
    return (
      <div style={styles.root}>
        <p style={styles.error}>无法读取 Q助理绑定状态：{error}（确认 web profile 已挂载 dsh-qzhuli 的 status-only 模式）</p>
      </div>
    )
  }

  const bound = status?.bound === true
  return (
    <div style={styles.root}>
      {status === null ? <p style={styles.muted}>读取绑定状态中…</p> : (
        <>
          <div style={styles.card}>
            <p style={styles.title}>Q助理网关绑定</p>
            <div style={styles.row}>
              {bound
                ? <span style={{ ...styles.badge, ...styles.badgeOk }}>● 已绑定（重启免扫码）</span>
                : <span style={{ ...styles.badge, ...styles.badgeWait }}>○ 等待扫码绑定</span>}
            </div>
            {bound && (
              <>
                <div style={styles.row}><span style={styles.muted}>会话 ID</span><code style={styles.mono}>{status.convId}</code></div>
                <div style={styles.row}><span style={styles.muted}>用户 CID</span><code style={styles.mono}>{status.senderCid}</code></div>
              </>
            )}
            <div style={styles.row}><span style={styles.muted}>工作区</span><code style={styles.mono}>{status.workspacePath}</code></div>
            {!bound && <div style={styles.row}><span style={styles.muted}>绑定密钥</span><code style={styles.mono}>{status.bindKey}</code></div>}
          </div>
          {!bound && status.qrcodeDataUrl !== undefined && (
            <div style={styles.card}>
              <p style={styles.title}>用手机 Q助理 App 扫码绑定</p>
              <img src={status.qrcodeDataUrl} alt="Q助理扫码绑定二维码" style={styles.qr} />
              <p style={styles.muted}>
                打开 Q助理手机 App → 右上角扫码 → 绑定「{status.bindKey}」机器人。扫码后请保持网关进程运行，绑定状态会自动更新。
              </p>
            </div>
          )}
        </>
      )}
    </div>
  )
}
