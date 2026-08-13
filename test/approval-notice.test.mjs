// dsh-win-notify 单元测试：Config 默认值 + 审批通知纯函数。
//
// 运行：npm test（node --experimental-test-module-mocks --test test/）
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 模块加载时会向 $DSH_HOME/dsh-win-notify.log 写一行；测试指向临时目录，不碰用户数据。
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), "dsh-win-notify-test-"));

const { Config, isApprovalDecided, approvalNoticeBody } = await import("../index.js");

const DEFAULTS = {
  approval: true,
  approvalWaitMs: 3000,
  bodyApproval: "等待用户审批",
  maxReasonChars: 80,
};

const asked = (data) => ({ type: "approval/asked", data });
const decided = (id) => ({ type: "approval/decided", data: { id, outcome: "allowed-once" } });

test("Config: 新选项有默认值", () => {
  const cfg = Config({});
  assert.equal(cfg.approval, DEFAULTS.approval);
  assert.equal(cfg.approvalWaitMs, DEFAULTS.approvalWaitMs);
  assert.equal(cfg.bodyApproval, DEFAULTS.bodyApproval);
  assert.equal(cfg.maxReasonChars, DEFAULTS.maxReasonChars);
  // 既有选项默认值不受影响
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.body, "任务已完成");
});

test("Config: 新选项可覆盖", () => {
  const cfg = Config({ approval: false, approvalWaitMs: 1000, bodyApproval: "需审批", maxReasonChars: 20 });
  assert.equal(cfg.approval, false);
  assert.equal(cfg.approvalWaitMs, 1000);
  assert.equal(cfg.bodyApproval, "需审批");
  assert.equal(cfg.maxReasonChars, 20);
});

test("approvalNoticeBody: 工具名 + 原因", () => {
  const body = approvalNoticeBody(
    asked({ id: "a1", toolName: "bash", reason: "escalate sandbox to write: 需要写文件" }),
    { ...DEFAULTS },
  );
  assert.equal(body, "等待用户审批：bash · escalate sandbox to write: 需要写文件");
});

test("approvalNoticeBody: 长原因截断", () => {
  const body = approvalNoticeBody(
    asked({ id: "a1", toolName: "bash", reason: "x".repeat(100) }),
    { ...DEFAULTS, maxReasonChars: 10 },
  );
  assert.equal(body, `等待用户审批：bash · ${"x".repeat(10)}…`);
});

test("approvalNoticeBody: 无原因时只有工具名", () => {
  const body = approvalNoticeBody(asked({ id: "a1", toolName: "bash" }), { ...DEFAULTS });
  assert.equal(body, "等待用户审批：bash");
});

test("approvalNoticeBody: 缺工具名回退「未知工具」", () => {
  const body = approvalNoticeBody(asked({ id: "a1" }), { ...DEFAULTS });
  assert.equal(body, "等待用户审批：未知工具");
});

test("approvalNoticeBody: 非 asked 事件返回 null", () => {
  assert.equal(approvalNoticeBody(decided("a1"), { ...DEFAULTS }), null);
  assert.equal(approvalNoticeBody({ type: "turn/end", data: {} }, { ...DEFAULTS }), null);
});

test("approvalNoticeBody: 缺少 id 返回 null", () => {
  assert.equal(approvalNoticeBody(asked({ toolName: "bash" }), { ...DEFAULTS }), null);
});

test("approvalNoticeBody: approval 关闭时返回 null", () => {
  assert.equal(approvalNoticeBody(asked({ id: "a1", toolName: "bash" }), { ...DEFAULTS, approval: false }), null);
});

test("isApprovalDecided: 匹配 id 的 decided 为 true", () => {
  assert.equal(isApprovalDecided([asked({ id: "a1" }), decided("a1")], "a1"), true);
});

test("isApprovalDecided: 未决定 / 不同 id / 空日志为 false", () => {
  assert.equal(isApprovalDecided([asked({ id: "a1" })], "a1"), false);
  assert.equal(isApprovalDecided([asked({ id: "a1" }), decided("a2")], "a1"), false);
  assert.equal(isApprovalDecided([], "a1"), false);
  assert.equal(isApprovalDecided(undefined, "a1"), false);
});
