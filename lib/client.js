window.__ModuleLoader__.load({
	id: "dsh-qzhuli",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		// src/client/QzhuliBindTab.tsx
		/**
		* Q助理绑定状态设置页：轮询 host 绑定状态 API，展示二维码 / 绑定信息。
		* 纯 React + fetch，无第三方 UI 依赖；内联样式保持 client bundle 轻量。
		*/
		const STATUS_URL = "/api/qzhuli/bind-status";
		const POLL_MS = 5e3;
		const styles = {
			root: {
				display: "flex",
				flexDirection: "column",
				gap: 16,
				padding: "4px 0"
			},
			card: {
				border: "1px solid var(--dsh-color-border, #e5e7eb)",
				borderRadius: 8,
				padding: 16,
				display: "flex",
				flexDirection: "column",
				gap: 10
			},
			title: {
				fontSize: 15,
				fontWeight: 600,
				margin: 0
			},
			row: {
				display: "flex",
				gap: 8,
				alignItems: "center",
				flexWrap: "wrap"
			},
			badge: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				padding: "2px 10px",
				borderRadius: 999,
				fontSize: 12,
				fontWeight: 600
			},
			badgeOk: {
				background: "#e6f7ee",
				color: "#1a7f43"
			},
			badgeWait: {
				background: "#fef4e6",
				color: "#b45309"
			},
			qr: {
				width: 200,
				height: 200,
				imageRendering: "pixelated"
			},
			mono: {
				fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
				fontSize: 12,
				wordBreak: "break-all"
			},
			muted: {
				fontSize: 12,
				color: "var(--dsh-color-text-secondary, #6b7280)"
			},
			error: {
				color: "#b42318",
				fontSize: 13
			}
		};
		/** 轮询 host 绑定状态。 */
		async function fetchStatus() {
			const response = await fetch(STATUS_URL, { cache: "no-store" });
			if (!response.ok) throw new Error(`bind-status HTTP ${response.status}`);
			return await response.json();
		}
		function QzhuliBindTab(_props) {
			const [status, setStatus] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			(0, react.useEffect)(() => {
				let disposed = false;
				let timer;
				const poll = async () => {
					try {
						const next = await fetchStatus();
						if (disposed) return;
						setStatus(next);
						setError(null);
					} catch (cause) {
						if (disposed) return;
						setError(cause instanceof Error ? cause.message : String(cause));
					}
					if (!disposed) timer = setTimeout(() => {
						poll();
					}, POLL_MS);
				};
				poll();
				return () => {
					disposed = true;
					if (timer) clearTimeout(timer);
				};
			}, []);
			if (error !== null && status === null) return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.root,
				children: /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
					style: styles.error,
					children: [
						"无法读取 Q助理绑定状态：",
						error,
						"（确认 web profile 已挂载 dsh-qzhuli 的 status-only 模式）"
					]
				})
			});
			const bound = status?.bound === true;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
				style: styles.root,
				children: status === null ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
					style: styles.muted,
					children: "读取绑定状态中…"
				}) : /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.title,
							children: "Q助理网关绑定"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("div", {
							style: styles.row,
							children: bound ? /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...styles.badge,
									...styles.badgeOk
								},
								children: "● 已绑定（重启免扫码）"
							}) : /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: {
									...styles.badge,
									...styles.badgeWait
								},
								children: "○ 等待扫码绑定"
							})
						}),
						bound && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.muted,
								children: "会话 ID"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								style: styles.mono,
								children: status.convId
							})]
						}), /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.muted,
								children: "用户 CID"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								style: styles.mono,
								children: status.senderCid
							})]
						})] }),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.muted,
								children: "工作区"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								style: styles.mono,
								children: status.workspacePath
							})]
						}),
						!bound && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
							style: styles.row,
							children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
								style: styles.muted,
								children: "绑定密钥"
							}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("code", {
								style: styles.mono,
								children: status.bindKey
							})]
						})
					]
				}), !bound && status.qrcodeDataUrl !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
					style: styles.card,
					children: [
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("p", {
							style: styles.title,
							children: "用手机 Q助理 App 扫码绑定"
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsx)("img", {
							src: status.qrcodeDataUrl,
							alt: "Q助理扫码绑定二维码",
							style: styles.qr
						}),
						/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("p", {
							style: styles.muted,
							children: [
								"打开 Q助理手机 App → 右上角扫码 → 绑定「",
								status.bindKey,
								"」机器人。扫码后请保持网关进程运行，绑定状态会自动更新。"
							]
						})
					]
				})] })
			});
		}
		// src/client/index.ts
		/** Services required by the Plugins-page registration. */
		const inject = ["slots"];
		/** Contribute the Q助理 tab to the Plugins page. */
		function apply(ctx) {
			ctx.slots.inject("plugins.tab", () => ctx.slots.register({
				name: "plugins.tab",
				id: "qzhuli",
				order: 20,
				label: () => "Q助理",
				locale: "qzhuli",
				inject: () => ({})
			}, QzhuliBindTab));
		}
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
