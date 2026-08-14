// dsh-win-notify client half — URL deep-link: ?session=<id> opens that session.
//
// Browser bundle in the dsh.client module format: the host's client-modules
// node half serves this file as /plugins/dsh-win-notify/client.js and the
// browser kernel loads it through window.__ModuleLoader__. When the page
// URL carries ?session=<id> (set by the toast launch URL), the plugin first
// hands the session to an existing same-origin GUI tab. With no live tab it
// opens locally, then strips the parameter so a refresh does not re-trigger.
window.__ModuleLoader__.load({
	id: "dsh-win-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const name = "win-notify-deeplink";
		const inject = ["sessions", "connection"];
		const HANDOFF_CHANNEL = "dsh-win-notify:session-handoff:v1";
		const newTabId = () => typeof window.crypto?.randomUUID === "function"
			? window.crypto.randomUUID()
			: String(Math.random()).slice(2);

		/** 从当前 URL 读取 session 参数（不存在则返回 undefined）。 */
		function targetSessionId() {
			try {
				const value = new URL(window.location.href).searchParams.get("session");
				return value === null || value === "" ? void 0 : value;
			} catch {
				return void 0;
			}
		}

		/** 从 URL 里清除 session 参数（页面刷新后不再重复触发）。 */
		function stripSessionParam() {
			try {
				const url = new URL(window.location.href);
				url.searchParams.delete("session");
				window.history.replaceState(null, "", url.pathname + url.search + url.hash);
			} catch { /* 忽略 */ }
		}

		/** 仅选择已经完成主机握手的标签页承接会话。 */
		function isConnected(ctx) {
			try {
				const connection = ctx.connection ?? ctx.get("connection");
				return connection?.hostDescription?.getSnapshot() !== void 0;
			} catch {
				return false;
			}
		}

		/** 当前会话列表是否已经包含目标会话。 */
		function isKnownSession(ctx, sessionId) {
			try {
				const sessions = ctx.sessions ?? ctx.get("sessions");
				const snapshot = sessions?.list?.getSnapshot();
				return snapshot?.phase === "ready" && snapshot.byId?.[sessionId] !== void 0;
			} catch {
				return false;
			}
		}

		/** 会话列表就绪时执行跳转；成功返回 true。 */
		function tryOpen(ctx, sessionId) {
			const sessions = ctx.sessions ?? ctx.get("sessions");
			if (sessions === void 0) return false;
			let snapshot;
			try {
				snapshot = sessions.list.getSnapshot();
			} catch {
				return false;
			}
			if (snapshot === void 0 || snapshot.phase !== "ready") return false;
			try {
				sessions.open(sessionId);
				stripSessionParam();
				return true;
			} catch {
				// 会话不在列表（已归档/子代理会话等）：清掉参数，只保留打开的 GUI。
				stripSessionParam();
				return true;
			}
		}

		/** 前台状态上报：页面聚焦且选中某会话时，宿主抑制该会话的通知。 */
		function setupFocusReporting(ctx, clientId) {
			const origin = window.location.origin;
			/** 以 GUI 持久化的当前选择为准；运行时快照仅作读取失败时的备用。 */
			const persistedSessionId = () => {
				try {
					const raw = window.localStorage?.getItem("dsh.sessions.current");
					const sessionId = raw === null || raw === "" ? "" : JSON.parse(raw)?.sessionId;
					return typeof sessionId === "string" && sessionId !== "" ? sessionId : "";
				} catch {
					return "";
				}
			};
			const currentSession = () => {
				const sessions = ctx.sessions ?? ctx.get("sessions");
				try {
					const snapshot = sessions?.list?.getSnapshot();
					const live = typeof snapshot?.current === "string" ? snapshot.current : "";
					return persistedSessionId() || live;
				} catch {
					return "";
				}
			};
			// 会话列表在流式事件期间会频繁刷新；状态未变时最多每 8 秒上报一次，
			// 仍比宿主 25 秒 TTL 更快，同时不会因每个 token 产生请求风暴。
			let lastReportKey = "";
			let lastReportAt = 0;
			const push = () => {
				const focused = (document.visibilityState ?? "visible") === "visible" && document.hasFocus();
				const sessionId = currentSession();
				const key = (focused ? "1" : "0") + "\u0000" + sessionId;
				const now = Date.now();
				if (key === lastReportKey && now - lastReportAt < 8000) return;
				lastReportKey = key;
				lastReportAt = now;
				fetch(origin + "/dsh-win-notify/focus?focused=" + (focused ? "1" : "0") + "&session=" + encodeURIComponent(sessionId) + "&client=" + encodeURIComponent(clientId), {
					method: "POST",
					keepalive: true,
				}).catch(() => {
					if (lastReportKey === key) lastReportAt = 0;
				});
			};
			const onState = () => push();
			// Cordis 在注册 effect 时立即执行回调，并只在卸载时调用其返回的 disposer。
			// 所有监听器与心跳必须在 effect 内创建，避免刚创建就被清理。
			ctx.effect(() => {
				document.addEventListener("visibilitychange", onState);
				window.addEventListener("focus", onState);
				window.addEventListener("blur", onState);
				let unsubscribe;
				const sessions = ctx.sessions ?? ctx.get("sessions");
				if (sessions !== undefined && typeof sessions.list?.subscribe === "function") {
					try {
						unsubscribe = sessions.list.subscribe(() => push());
					} catch { /* 忽略 */ }
				}
				const heartbeat = setInterval(push, 10000);
				push();
				return () => {
					document.removeEventListener("visibilitychange", onState);
					window.removeEventListener("focus", onState);
					window.removeEventListener("blur", onState);
					if (unsubscribe !== undefined) try { unsubscribe(); } catch { /* 忽略 */ }
					clearInterval(heartbeat);
				};
			}, "dsh-win-notify: focus reporting");
		}

		/** 会话服务/列表尚未就绪时持续尝试打开，返回可取消的清理函数。 */
		function openSessionWhenReady(ctx, sessionId, onDone) {
			let stopped = false;
			let pollTimer;
			let disposeService = () => {};
			const stop = () => {
				if (stopped) return;
				stopped = true;
				disposeService();
				if (pollTimer !== void 0) clearInterval(pollTimer);
			};
			const attempt = () => {
				if (stopped) return;
				if (tryOpen(ctx, sessionId)) {
					stop();
					try { onDone?.(); } catch { /* 忽略 */ }
				}
			};
			disposeService = ctx.on("internal/service", attempt);
			pollTimer = setInterval(attempt, 500);
			attempt();
			return stop;
		}

		/** 为每个已打开的 GUI 标签监听来自新通知标签的会话交接请求。 */
		function setupTabHandoff(ctx, tabId) {
			if (typeof BroadcastChannel !== "function") return;
			ctx.effect(() => {
				let channel;
				try {
					channel = new BroadcastChannel(HANDOFF_CHANNEL);
				} catch {
					return;
				}
				const incoming = new Map();
				let lastFocusedAt = document.hasFocus() ? Date.now() : 0;
				const noteFocus = () => {
					if (document.hasFocus()) lastFocusedAt = Date.now();
				};
				const stopIncoming = () => {
					for (const stop of incoming.values()) stop();
					incoming.clear();
				};
				const send = (message) => {
					try { channel.postMessage(message); } catch { /* 忽略 */ }
				};
				channel.onmessage = (event) => {
					const message = event.data;
					if (message === null || typeof message !== "object" || message.from === tabId) return;
					if (message.type === "discover" && typeof message.requestId === "string" && typeof message.from === "string") {
						if (!isConnected(ctx)) return;
						send({
							type: "present",
							requestId: message.requestId,
							from: tabId,
							to: message.from,
							focused: document.hasFocus(),
							visible: (document.visibilityState ?? "visible") === "visible",
							lastFocusedAt,
						});
						return;
					}
					if (message.type !== "open" || message.to !== tabId || typeof message.requestId !== "string" || typeof message.from !== "string" || typeof message.sessionId !== "string") return;
					if (!isConnected(ctx) || !isKnownSession(ctx, message.sessionId)) return;
					stopIncoming();
					let finished = false;
					const stop = openSessionWhenReady(ctx, message.sessionId, () => {
						finished = true;
						incoming.delete(message.requestId);
						send({ type: "opened", requestId: message.requestId, from: tabId, to: message.from });
						try { window.focus(); } catch { /* 浏览器可能拒绝非用户手势聚焦 */ }
					});
					if (!finished) incoming.set(message.requestId, stop);
				};
				window.addEventListener("focus", noteFocus);
				return () => {
					window.removeEventListener("focus", noteFocus);
					stopIncoming();
					channel.onmessage = null;
					channel.close();
				};
			}, "dsh-win-notify: tab handoff listener");
		}

		/** 通知启动的新页优先把会话交给已有 GUI 标签；没有候选时才在自己打开。 */
		function handoffOrOpenHere(ctx, sessionId, tabId) {
			ctx.effect(() => {
				let channel;
				let discoveryTimer;
				let acknowledgementTimer;
				let closeFallbackTimer;
				let localStop;
				let disposed = false;
				let handoffComplete = false;
				const candidates = new Map();
				const clearTimers = () => {
					if (discoveryTimer !== void 0) clearTimeout(discoveryTimer);
					if (acknowledgementTimer !== void 0) clearTimeout(acknowledgementTimer);
					if (closeFallbackTimer !== void 0) clearTimeout(closeFallbackTimer);
				};
				const closeChannel = () => {
					if (channel === void 0) return;
					channel.onmessage = null;
					channel.close();
					channel = void 0;
				};
				const startLocal = () => {
					if (disposed || localStop !== void 0) return;
					clearTimers();
					closeChannel();
					localStop = openSessionWhenReady(ctx, sessionId);
				};
				const chooseCandidate = () => [...candidates.values()].sort((a, b) =>
					Number(Boolean(b.focused)) - Number(Boolean(a.focused)) ||
					Number(b.lastFocusedAt || 0) - Number(a.lastFocusedAt || 0) ||
					Number(Boolean(b.visible)) - Number(Boolean(a.visible)),
				)[0];
				const closeSelfOrFallback = () => {
					try { window.close(); } catch { /* 忽略，稍后在当前页兜底 */ }
					// 部分 Chromium 版本仅允许关闭 script-closable 标签；尝试把当前页标记为 self-opened。
					if (!window.closed) try { window.open("", "_self"); window.close(); } catch { /* 忽略 */ }
					// 外部 URL 打开的标签可能仍被浏览器禁止脚本关闭；此时保留原有跳转能力。
					closeFallbackTimer = setTimeout(() => {
						if (!window.closed) startLocal();
					}, 350);
				};
				const startDiscovery = () => {
					if (typeof BroadcastChannel !== "function") {
						startLocal();
						return;
					}
					try {
						channel = new BroadcastChannel(HANDOFF_CHANNEL);
					} catch {
						startLocal();
						return;
					}
					channel.onmessage = (event) => {
						const message = event.data;
						if (message === null || typeof message !== "object" || message.to !== tabId || typeof message.requestId !== "string") return;
						if (message.requestId !== requestId) return;
						if (message.type === "present" && typeof message.from === "string") {
							candidates.set(message.from, message);
							return;
						}
						if (message.type !== "opened" || handoffComplete || localStop !== void 0) return;
						handoffComplete = true;
						if (discoveryTimer !== void 0) clearTimeout(discoveryTimer);
						if (acknowledgementTimer !== void 0) clearTimeout(acknowledgementTimer);
						closeChannel();
						closeSelfOrFallback();
					};
					try {
						channel.postMessage({ type: "discover", requestId, from: tabId });
					} catch {
						startLocal();
						return;
					}
					discoveryTimer = setTimeout(() => {
						const target = chooseCandidate();
						if (target === void 0) {
							startLocal();
							return;
						}
						try {
							channel.postMessage({ type: "open", requestId, from: tabId, to: target.from, sessionId });
							acknowledgementTimer = setTimeout(startLocal, 800);
						} catch {
							startLocal();
						}
					}, 250);
				};
				const requestId = newTabId();
				startDiscovery();
				return () => {
					disposed = true;
					clearTimers();
					closeChannel();
					if (localStop !== void 0) localStop();
				};
			}, "dsh-win-notify: toast tab handoff");
		}

		function apply(ctx) {
			const tabId = newTabId();
			// 前台状态上报和跨标签页交接始终启用。
			setupFocusReporting(ctx, tabId);
			setupTabHandoff(ctx, tabId);
			const sessionId = targetSessionId();
			if (sessionId !== void 0) handoffOrOpenHere(ctx, sessionId, tabId);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;

		return module.exports;
	}
});
