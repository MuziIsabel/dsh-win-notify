// dsh-win-notify 集成测试：apply() 的 session/event 接线 + 防抖 + 抑制逻辑。
//
// mock 掉 node:child_process.spawn —— 不真正弹出通知、不跑注册脚本；
// 通过解码 -EncodedCommand（UTF-16LE base64）断言 toast 脚本内容。
//
// 运行：npm test（node --experimental-test-module-mocks --test test/）
import assert from "node:assert/strict";
import { test, mock } from "node:test";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 模块加载时会向 $DSH_HOME/dsh-win-notify.log 写一行；测试指向临时目录，不碰用户数据。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-win-notify-test-"));

const spawnCalls = [];
mock.module("node:child_process", {
  namedExports: {
    spawn(exe, args, opts) {
      spawnCalls.push({ exe, args, opts });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { on() {} };
      setImmediate(() => child.emit("exit", 0)); // 模拟注册/通知脚本正常退出
      return child;
    },
  },
});

const { apply } = await import("../index.js");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeScript(call) {
  // args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", <base64>]
  return Buffer.from(call.args[3], "base64").toString("utf16le");
}

/** 已发出的 toast 通知脚本（排除身份注册脚本）。 */
function toastScripts() {
  return spawnCalls.map(decodeScript).filter((script) => script.includes("CreateToastNotifier"));
}

/** 极简 ctx：只保留插件用到的 on/logger。 */
function makeCtx() {
  const handlers = new Map();
  const ctx = {
    on(event, handler) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    logger: { info() {}, warn() {} },
  };
  return { ctx, handlers };
}

const asked = (data) => ({ type: "approval/asked", data });
const decided = (id) => ({ type: "approval/decided", data: { id, outcome: "allowed-once" } });

test("asked 超过阈值仍未决定 → 弹「等待用户审批」toast", async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { approvalWaitMs: 30 });
  const sessionEvents = [{ type: "approval/asked", data: { id: "a1", toolName: "bash", reason: "escalate" } }];
  handlers.get("session/event")({ events: sessionEvents }, asked({ id: "a1", toolName: "bash", reason: "escalate" }));
  await sleep(150);
  const scripts = toastScripts();
  assert.equal(scripts.length, 1);
  assert.match(scripts[0], /等待用户审批/);
  assert.match(scripts[0], /bash/);
  assert.match(scripts[0], /escalate/);
  assert.match(scripts[0], /DeepSeek Harness/);
});

test("阈值内已 decided → 不弹通知", async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { approvalWaitMs: 50 });
  const before = toastScripts().length;
  const sessionEvents = [asked({ id: "a2", toolName: "bash" }), decided("a2")];
  const session = { events: sessionEvents };
  handlers.get("session/event")(session, asked({ id: "a2", toolName: "bash" }));
  handlers.get("session/event")(session, decided("a2"));
  await sleep(150);
  assert.equal(toastScripts().length, before);
});

test("approval 关闭 → 不弹通知", async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { approval: false, approvalWaitMs: 30 });
  const before = toastScripts().length;
  handlers.get("session/event")({ events: [] }, asked({ id: "a3", toolName: "bash" }));
  await sleep(150);
  assert.equal(toastScripts().length, before);
});

test("非审批事件被忽略", async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { approvalWaitMs: 30 });
  const before = toastScripts().length;
  handlers.get("session/event")({ events: [] }, { type: "turn/start", data: {} });
  handlers.get("session/event")({ events: [] }, { type: "tool/call", data: { name: "bash" } });
  await sleep(150);
  assert.equal(toastScripts().length, before);
});

test("同一 asked 事件重复到达只通知一次", async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { approvalWaitMs: 30 });
  const sessionEvents = [asked({ id: "a4", toolName: "pwsh" })];
  const session = { events: sessionEvents };
  const event = asked({ id: "a4", toolName: "pwsh" });
  handlers.get("session/event")(session, event);
  handlers.get("session/event")(session, event); // 同一事件重复投递
  await sleep(150);
  const scripts = toastScripts();
  assert.equal(scripts.filter((s) => s.includes("pwsh")).length, 1);
});

test("任务完成通知逻辑不受影响（running → idle 仍会通知）", async () => {
  const { ctx, handlers } = makeCtx();
  apply(ctx, { approvalWaitMs: 30 });
  const before = toastScripts().length;
  const agent = { session: { events: [{ type: "turn/end", data: { reason: { kind: "completed" } } }, { type: "user/message", data: { content: [{ type: "text", text: "帮我查天气" }] } }] } };
  handlers.get("agent/status")({ status: "running", agent });
  handlers.get("agent/status")({ status: "idle", agent });
  await sleep(150);
  const scripts = toastScripts();
  assert.equal(scripts.length, before + 1);
  assert.match(scripts[scripts.length - 1], /任务已完成/);
  assert.match(scripts[scripts.length - 1], /帮我查天气/);
});
