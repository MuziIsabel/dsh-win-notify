import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { loadPlugin } from "./support/load-plugin.js";

function fixture({ convert = (p) => "\\\\wsl.localhost\\Ubuntu" + p.replaceAll("/", "\\"), host = true, result = true, spawnError = false } = {}) {
  const calls = [], writes = [], removed = [], logs = [], timers = [], handlers = new Map();
  let now = 100000;
  const ctx = { logger: { warn: (s) => logs.push(s), info: (s) => logs.push(s) },
    on: (event, fn) => { handlers.set(event, fn); }, get: () => undefined };
  const api = loadPlugin({
    resolveWindowsHost: () => host ? { powershell: "/interop/powershell.exe", toWindowsPath: convert } : null,
    appendFileSync: (_p, s) => logs.push(s), tmpdir: () => "/tmp",
    writeFileSync: (...args) => writes.push(args), unlinkSync: (p) => removed.push(p),
    Date: class extends Date { static now() { return now; } },
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.push(t); return t; }, clearTimeout: () => {},
    spawn: (exe, args, options) => {
      if (spawnError) throw new Error("spawn failed");
      const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      calls.push({ exe, args, options, child });
      queueMicrotask(() => { child.stdout.emit("data", Buffer.from(result ? "registered scheme=1" : "")); child.emit("exit", result ? 0 : 1); });
      return child;
    },
  });
  return { api, ctx, calls, writes, removed, logs, timers, handlers, advance: () => { now += 10001; } };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test("WSL registration translates and quotes icon plus staged UTF-16LE script; cleans up", async () => {
  const f = fixture({ convert: (p) => "C:\\a b's" + p.replaceAll("/", "\\") });
  assert.equal((await f.api.ensureRegistered(f.ctx)).toast, true);
  const { args } = f.calls[0];
  assert.equal(args.at(-2), "-File");
  assert.ok(args.at(-1).startsWith("C:\\a b's\\tmp\\"));
  assert.equal(f.writes[0][2], "utf16le");
  assert.ok(f.writes[0][1].startsWith("\ufeff"));
  assert.match(f.writes[0][1], /Copy-Item -LiteralPath 'C:\\a b''s/);
  assert.ok(f.writes[0][1].includes("WPF\\UIAutomationClient.dll"));
  assert.ok(f.writes[0][1].includes("WPF\\UIAutomationTypes.dll"));
  assert.deepEqual(f.removed, [f.writes[0][0]]);
  await f.api.ensureRegistered(f.ctx);
  assert.equal(f.calls.length, 1);
});

test("small scripts use EncodedCommand without creating a file", async () => {
  const f = fixture();
  f.api.runPowerShell(f.ctx, "/interop/powershell.exe", "Write-Output '你好'", undefined, "test");
  await flush();
  assert.equal(f.calls[0].args.at(-2), "-EncodedCommand");
  assert.equal(Buffer.from(f.calls[0].args.at(-1), "base64").toString("utf16le"), "Write-Output '你好'");
  assert.equal(f.writes.length, 0);
});

test("staging path conversion failure removes the Linux file and reports failure", () => {
  const f = fixture({ convert: () => { throw new Error("wslpath failed"); } });
  let ok;
  f.api.runPowerShell(f.ctx, "/interop/powershell.exe", "x".repeat(12000), (value) => { ok = value; }, "test");
  assert.equal(ok, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.removed, [f.writes[0][0]]);
});

test("synchronous spawn/path failures remain retryable after the cooldown", async () => {
  for (const options of [{ spawnError: true }, { convert: () => { throw new Error("no wslpath"); } }]) {
    const f = fixture(options);
    assert.equal((await f.api.ensureRegistered(f.ctx)).toast, false);
    await flush();
    f.advance();
    assert.equal((await f.api.ensureRegistered(f.ctx)).toast, false);
    assert.equal(f.logs.filter((s) => s.includes("registration attempt start")).length, 2);
  }
});

test("registration failure sends a WSL balloon using built-in PowerShell, without pwsh", async () => {
  const f = fixture({ result: false });
  f.api.showToast(f.ctx, f.api.DEFAULTS, "test", "body", undefined, "session-test");
  await flush();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].exe, "/interop/powershell.exe");
  assert.match(Buffer.from(f.calls[1].args.at(-1), "base64").toString("utf16le"), /System.Windows.Forms.NotifyIcon/);
});

test("asynchronous registration failure retries only after the cooldown", async () => {
  const f = fixture({ result: false });
  assert.equal((await f.api.ensureRegistered(f.ctx)).toast, false);
  await flush();
  assert.equal((await f.api.ensureRegistered(f.ctx)).toast, false);
  assert.equal(f.calls.length, 1);
  f.advance();
  assert.equal((await f.api.ensureRegistered(f.ctx)).toast, false);
  assert.equal(f.calls.length, 2);
});

test("missing interop is logged and does not spawn", async () => {
  const f = fixture({ host: false });
  assert.equal((await f.api.ensureRegistered(f.ctx)).toast, false);
  f.api.showToast(f.ctx, f.api.DEFAULTS, "test", "body");
  assert.equal(f.calls.length, 0);
  assert.ok(f.logs.some((s) => s.includes("registration unavailable")));
});

test("native Windows staging leaves paths unchanged", async () => {
  const f = fixture({ convert: (p) => p });
  await f.api.ensureRegistered(f.ctx);
  assert.equal(f.calls[0].args.at(-1), f.writes[0][0]);
});

test("completion, aborted, subagent and focus suppression behavior is preserved", async () => {
  const f = fixture();
  f.api.apply(f.ctx);
  await flush();
  const status = f.handlers.get("agent/status");
  for (const [kind, origin, focused, expected] of [
    ["completed", undefined, false, 1], ["aborted", undefined, false, 0],
    ["completed", "subagent", false, 0], ["completed", undefined, true, 0],
  ]) {
    const agent = { session: { id: "session-test", header: { origin }, events: [{ type: "turn/end", data: { reason: { kind } } }] } };
    f.api.clientViews.clear();
    if (focused) f.api.clientViews.set("client", { focused: true, sessionId: "session-test", at: 100000 });
    const count = f.calls.length;
    status({ status: "running", agent }); status({ status: "idle", agent });
    await flush();
    assert.equal(f.calls.length - count, expected);
  }
});

test("toast preserves sound selection and protocol click URL", () => {
  const f = fixture();
  const script = f.api.toastScript("你好", "body & text", "default", "dsh-win-notify://activate?session=test&token=secret");
  assert.match(script, /ms-winsoundevent:Notification.Default/);
  assert.match(script, /activationType="protocol"/);
  assert.match(script, /session=test&amp;token=secret/);
  assert.match(f.api.toastScript("t", "b", "silent"), /audio silent="true"/);
});
