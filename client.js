// dsh-win-notify client half — URL deep-link: ?session=<id> opens that session.
//
// Browser bundle in the dsh.client module format: the host's client-modules
// node half serves this file as /plugins/dsh-win-notify/client.js and the
// browser kernel loads it through window.__ModuleLoader__. When the page
// URL carries ?session=<id> (set by the toast launch URL), the plugin waits
// for the client sessions service, opens that session, and strips the
// parameter so a refresh does not re-trigger.
window.__ModuleLoader__.load({
	id: "dsh-win-notify",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const name = "win-notify-deeplink";
		const inject = ["sessions"];

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

		/** 会话列表就绪且目标会话存在时执行跳转；成功返回 true。 */
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
		function setupFocusReporting(ctx) {
			const origin = window.location.origin;
			/** 每个标签页一个稳定 id（页面生命周期内不变），宿主按客户端分组。 */
			const clientId = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Math.random()).slice(2);
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

		function apply(ctx) {
			// 前台状态上报始终启用（有无深链参数都上报）
			setupFocusReporting(ctx);

			const sessionId = targetSessionId();
			if (sessionId === void 0) return;

			let stopped = false;
			let pollTimer;
			const stop = () => {
				if (stopped) return;
				stopped = true;
				disposeService();
				if (pollTimer !== void 0) clearInterval(pollTimer);
			};
			const attempt = () => {
				if (stopped) return;
				if (tryOpen(ctx, sessionId)) stop();
			};
			// sessions 服务尚未挂载时，等它出现
			const disposeService = ctx.on("internal/service", attempt);
			// 服务已在但列表未 ready 时轮询
			pollTimer = setInterval(attempt, 500);
			attempt();
			ctx.effect(() => stop);
		}

		exports.name = name;
		exports.inject = inject;
		exports.apply = apply;

		return module.exports;
	}
});
