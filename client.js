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
		const inject = [];

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
			const sessions = ctx.get("sessions");
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

		function apply(ctx) {
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
