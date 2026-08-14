// dsh-win-notify — Windows 任务完成提醒插件
//
// 任务回合结束（agent/status: running → idle）时弹出 Windows Toast 通知并播放提示音。
//
// 关键实现点：
//  - Windows 只展示「已注册身份」的 toast：插件激活时自动注册桌面应用身份 ——
//    编译一个 DeepSeek.exe 占位程序 + 开始菜单 DeepSeek.lnk 快捷方式
//    （图标用官方 favicon 生成的多尺寸 DeepSeek.ico），
//    AppUserModelID = DSH.WinNotify，通知显示名与图标即 DeepSeek；
//  - 注册失败或 powershell.exe 缺失时回退到 NotifyIcon 气泡（无需注册也能显示）；
//  - 中文通过 -EncodedCommand（UTF-16LE base64）传递，不会乱码；
//  - 用户手动停止（turn/end reason: aborted）不算完成，不弹通知；
//  - 等待用户审批（approval/asked 之后超过 approvalWaitMs 仍未 approval/decided）时弹通知。
//  - 运行日志写到 $DSH_HOME/dsh-win-notify.log。

import { spawn } from "node:child_process";
import { existsSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import z from "@deepseek-ai/schemastery";

export const name = "dsh-win-notify";

export const Config = z.object({
  enabled: z.boolean().default(true),
  // default | reminder | sms | alarm | silent
  sound: z.string().default("default"),
  onError: z.boolean().default(true),
  title: z.string().default("DeepSeek Harness"),
  body: z.string().default("任务已完成"),
  bodyError: z.string().default("任务出错"),
  maxPromptChars: z.number().default(64),
  // 点击通知时用浏览器打开 GUI 并跳转到对应会话
  openOnClick: z.boolean().default(true),
  // 自定义 GUI 根地址（默认自动取 webServer 的端口，本机用 127.0.0.1）
  baseUrl: z.string().default(""),
  // 等待用户审批（sandbox 提权等）时的通知
  approval: z.boolean().default(true),
  // approval/asked 后等多久仍未决定才通知（毫秒）——快速自动决定的不打扰
  approvalWaitMs: z.number().default(3000),
  bodyApproval: z.string().default("等待用户审批"),
  maxReasonChars: z.number().default(80),
  // 等待用户回复（ask_user_question 提问）时的通知
  question: z.boolean().default(true),
  // 提问后等多久仍未被回答才通知（毫秒）
  questionWaitMs: z.number().default(3000),
  bodyQuestion: z.string().default("等待用户回复"),
  maxQuestionChars: z.number().default(80),
  // 页面在前台查看该会话时，抑制该会话的通知（避免打扰正在盯着 GUI 的用户）
  suppressWhenVisible: z.boolean().default(true),
  // 前台状态的保鲜期：客户端每 ~10 秒心跳一次，超时视为页面已关闭
  visibilityTtlMs: z.number().default(25000),
});

const DEFAULTS = {
  enabled: true,
  sound: "default",
  onError: true,
  title: "DeepSeek Harness",
  body: "任务已完成",
  bodyError: "任务出错",
  maxPromptChars: 64,
  openOnClick: true,
  baseUrl: null,
  approval: true,
  approvalWaitMs: 3000,
  bodyApproval: "等待用户审批",
  maxReasonChars: 80,
  question: true,
  questionWaitMs: 3000,
  bodyQuestion: "等待用户回复",
  maxQuestionChars: 80,
  suppressWhenVisible: true,
  visibilityTtlMs: 25000,
};

/** 注册过的 toast 身份（必须与开始菜单快捷方式的 AppUserModelID 一致）。 */
const APP_ID = "DSH.WinNotify";
const SHORTCUT_NAME = "DeepSeek.lnk";
const OLD_SHORTCUT_NAME = "dsh-win-notify.lnk";
const APP_DIR_NAME = "DeepSeek"; // %LOCALAPPDATA%\DeepSeek
const STUB_EXE = "DeepSeek.exe";
const ICON_FILE = "DeepSeek.ico";
const PLUGIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const ICON_SOURCE = join(PLUGIN_DIR, "assets", ICON_FILE);
const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-win-notify.log");
function log(msg) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`); } catch { /* 忽略日志错误 */ }
}
log("module loaded"); // 模块被 import 时立即记录

/** 浏览器上报的前台状态：{ sessionId, focused } + 最近上报时间（模块级，多标签页以最后一次上报为准）。 */
let clientView = null;
let clientViewAt = 0;

/** 该会话是否正被用户在前台查看（聚焦且选中）——是则不打扰。 */
function suppressFor(sessionId, cfg) {
  if (!cfg.suppressWhenVisible) return false;
  if (clientView === null) return false;
  const ttl = Math.max(5000, Number(cfg.visibilityTtlMs) || 25000);
  if (Date.now() - clientViewAt > ttl) { clientView = null; return false; }
  if (clientView.focused !== true) return false;
  return typeof sessionId === "string" && sessionId !== "" && clientView.sessionId === sessionId;
}

/** ms-winsoundevent 声音映射；null 表示静音。 */
const SOUNDS = {
  default: "ms-winsoundevent:Notification.Default",
  reminder: "ms-winsoundevent:Notification.Reminder",
  sms: "ms-winsoundevent:Notification.SMS",
  alarm: "ms-winsoundevent:Notification.Looping.Alarm",
  silent: null,
};

/** Windows PowerShell 5.1（带 WinRT 投影，能弹 Toast）。 */
const PS5 = join(
  process.env.SystemRoot ?? "C:\\Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);

/** C# 帮助类：给 .lnk 快捷方式写 AppUserModelID（IPropertyStore P/Invoke）。 */
const PROPSTORE_CS = "using System;\nusing System.Runtime.InteropServices;\n\npublic static class PropStore\n{\n    private static readonly Guid IID_IPropertyStore = new Guid(\"886d8eeb-8cf2-4446-8d02-cdba1dbdcf99\");\n    private static readonly Guid PKEY_AppUserModel_ID = new Guid(\"9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3\");\n\n    [StructLayout(LayoutKind.Sequential)]\n    private struct PropertyKey { public Guid fmtid; public uint pid; }\n\n    [ComImport, Guid(\"886d8eeb-8cf2-4446-8d02-cdba1dbdcf99\"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]\n    private interface IPropertyStore\n    {\n        int GetCount(out uint cProps);\n        int GetAt(uint iProp, out PropertyKey pkey);\n        int GetValue(ref PropertyKey key, out IntPtr pv);\n        int SetValue(ref PropertyKey key, ref PropVariant pv);\n        int Commit();\n    }\n\n    [StructLayout(LayoutKind.Explicit)]\n    private struct PropVariant\n    {\n        [FieldOffset(0)] public ushort vt;\n        [FieldOffset(8)] public IntPtr ptr;\n    }\n\n    [DllImport(\"shell32.dll\", CharSet = CharSet.Unicode)]\n    private static extern int SHGetPropertyStoreFromParsingName(string pszPath, IntPtr pbc, uint flags, ref Guid riid, out IntPtr ppv);\n\n    [DllImport(\"ole32.dll\")]\n    private static extern int PropVariantClear(ref IntPtr pvar);\n\n    /// <summary>Write appId onto the shortcut's AppUserModelID property (idempotent).</summary>\n    public static void SetAppUserModelId(string lnkPath, string appId)\n    {\n        Guid iid = IID_IPropertyStore;\n        IntPtr storePtr;\n        int hr = SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2 /*GPS_READWRITE*/, ref iid, out storePtr);\n        if (hr != 0) throw new COMException(\"open: 0x\" + hr.ToString(\"X8\"));\n        object obj = Marshal.GetObjectForIUnknown(storePtr);\n        try\n        {\n            IPropertyStore store = (IPropertyStore)obj;\n            PropertyKey key = new PropertyKey { fmtid = PKEY_AppUserModel_ID, pid = 5 };\n            PropVariant write = new PropVariant { vt = 31, ptr = Marshal.StringToCoTaskMemUni(appId) };\n            try\n            {\n                hr = store.SetValue(ref key, ref write);\n                if (hr != 0) throw new COMException(\"SetValue: 0x\" + hr.ToString(\"X8\"));\n                hr = store.Commit();\n                if (hr != 0) throw new COMException(\"Commit: 0x\" + hr.ToString(\"X8\"));\n            }\n            finally { PropVariantClear(ref write.ptr); }\n        }\n        finally { Marshal.FinalReleaseComObject(obj); }\n    }\n}\n";

/** 身份注册脚本（幂等）：占位程序 + 图标 + 快捷方式 + AUMID，并迁移旧快捷方式。 */
function registrationScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$appDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) '" + APP_DIR_NAME + "'",
    "New-Item -ItemType Directory -Force -Path $appDir | Out-Null",
    "$exe = Join-Path $appDir '" + STUB_EXE + "'",
    "if (-not (Test-Path $exe)) {",
    "  Add-Type -TypeDefinition @'",
    "using System;",
    "class Program { static void Main() { } }",
    "'@ -OutputAssembly $exe -OutputType ConsoleApplication",
    "}",
    "Copy-Item '" + ICON_SOURCE + "' (Join-Path $appDir '" + ICON_FILE + "') -Force",
    "$startMenu = [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs)",
    "$lnkPath = Join-Path $startMenu '" + SHORTCUT_NAME + "'",
    "$shell = New-Object -ComObject WScript.Shell",
    "$lnk = $shell.CreateShortcut($lnkPath)",
    "$lnk.TargetPath = $exe",
    "$lnk.IconLocation = (Join-Path $appDir '" + ICON_FILE + "')",
    "$lnk.Description = 'DeepSeek Harness notifications'",
    "$lnk.Save()",
    "[System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($lnk) | Out-Null",
    "Add-Type -TypeDefinition @'",
    PROPSTORE_CS,
    "'@",
    "$done = $false",
    "$attempts = 0",
    "do {",
    "  try {",
    "    [PropStore]::SetAppUserModelId($lnkPath, '" + APP_ID + "')",
    "    $done = $true",
    "  } catch {",
    "    $attempts++",
    "    if ($attempts -ge 5) { throw }",
    "    Start-Sleep -Milliseconds 600",
    "  }",
    "} while (-not $done)",
    "$old = Join-Path $startMenu '" + OLD_SHORTCUT_NAME + "'",
    "if (Test-Path $old) { Remove-Item $old -Force }",
    "Write-Output 'registered'",
  ].join("\n");
}

/** 启动一个独立的 PowerShell 进程执行脚本（fire-and-forget）。 */
function runPowerShell(ctx, executable, script, onDone, label) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let child;
  try {
    child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    log(`spawn fail ${label}: ${error.message}`);
    ctx.logger.warn(`dsh-win-notify: 无法启动通知进程 ${executable}: ${error.message}`);
    onDone?.(false, "");
    return;
  }
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
  let failed = false;
  child.on("error", (error) => {
    failed = true;
    log(`process error ${label}: ${error.message}`);
    ctx.logger.warn(`dsh-win-notify: 通知进程错误: ${error.message}`);
    onDone?.(false, stderr);
  });
  child.on("exit", (code) => {
    log(`exit ${label}: code=${code} stderr=${stderr.slice(0, 600).replace(/\\s+/g, " ")}`);
    if (code !== 0 && !failed) {
      ctx.logger.warn(`dsh-win-notify: 通知进程退出码 ${code}`);
      onDone?.(false, stderr);
      return;
    }
    onDone?.(code === 0, stderr);
  });
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function truncate(text, max) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return t.slice(0, max) + "…";
}

/** 该会话最近一次 turn/end 的 reason（undefined = 找不到）。 */
function lastTurnEndReason(agent) {
  try {
    const events = agent?.session?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== "turn/end") continue;
      return event.data?.reason;
    }
  } catch { /* 投影失败按完成处理 */ }
  return undefined;
}

/** 该会话最近一条「用户本人」消息的文本（跳过系统注入的 runtime context / system-reminder）。 */
function lastUserPrompt(agent) {
  try {
    const events = agent?.session?.events ?? [];
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type !== "user/message") continue;
      const data = event.data;
      const sourceKind = data?.source?.kind;
      if (sourceKind !== undefined && sourceKind !== "user") continue; // 系统注入（plugin/skill-catalog 等），跳过
      const block = Array.isArray(data?.content) ? data.content[0] : null;
      if (block?.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text !== "") return text;
      }
    }
  } catch { /* 忽略 */ }
  return "";
}

/**
 * 该 approval/asked 是否已被 approval/decided 决定（按 id 匹配）。
 * asked → decided 在会话日志中成对出现；id 为 UUID，decided 必在 asked 之后。
 */
export function isApprovalDecided(events, id) {
  try {
    for (const event of events ?? []) {
      if (event?.type === "approval/decided" && event.data?.id === id) return true;
    }
  } catch { /* 读不到按未决定处理 */ }
  return false;
}

/**
 * 由 approval/asked 事件生成「等待审批」通知正文；无需通知时返回 null。
 * 纯函数：调用方负责在等待阈值后先复核 isApprovalDecided 再生成正文。
 */
export function approvalNoticeBody(event, cfg) {
  if (cfg?.approval === false) return null;
  if (event?.type !== "approval/asked") return null;
  const id = event.data?.id;
  if (typeof id !== "string" || id === "") return null;
  const toolName = String(event.data?.toolName ?? "").trim() || "未知工具";
  const reason = typeof event.data?.reason === "string" ? event.data.reason.trim() : "";
  const parts = [`${cfg.bodyApproval}：${toolName}`];
  if (reason !== "") parts.push(truncate(reason, Math.max(1, Number(cfg.maxReasonChars) || 80)));
  return parts.join(" · ");
}

/** 生成弹 Toast 的 PowerShell 脚本（WinRT ToastNotification，注册身份）。
*  @param launch - 可选点击跳转 URL：点击通知后 Windows 用默认浏览器打开它。 */
function toastScript(title, body, sound, launch) {
  const src = Object.hasOwn(SOUNDS, sound) ? SOUNDS[sound] : SOUNDS.default;
  const audio = src === null
    ? '<audio silent="true" />'
    : `<audio src="${escapeXml(src)}" />`;
  const textTitle = escapeXml(title);
  const textBody = escapeXml(body);
  const activation = launch === void 0 || launch === ""
    ? ""
    : ` activationType="protocol" launch="${escapeXml(launch)}"`;
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
    `$xmlText = '<toast${activation} duration="long"><visual><binding template="ToastGeneric"><text>${textTitle}</text><text>${textBody}</text></binding></visual>${audio}</toast>'`,
    "$doc = New-Object Windows.Data.Xml.Dom.XmlDocument",
    "$doc.LoadXml($xmlText)",
    "$toast = New-Object Windows.UI.Notifications.ToastNotification $doc",
    `$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('${APP_ID}')`,
    "$notifier.Show($toast)",
  ].join("\n");
}

/** 回退方案：pwsh + NotifyIcon 气泡（带系统提示音）。 */
function balloonScript(title, body) {
  const textTitle = escapeXml(title);
  const textBody = escapeXml(body);
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$icon = [System.Drawing.SystemIcons]::Information",
    "$n = New-Object System.Windows.Forms.NotifyIcon",
    "$n.Icon = $icon",
    `$n.BalloonTipTitle = '${textTitle}'`,
    `$n.BalloonTipText = '${textBody}'`,
    "$n.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info",
    "$n.Visible = $true",
    "$n.ShowBalloonTip(8000)",
    "Start-Sleep -Milliseconds 8500",
    "$n.Dispose()",
  ].join("\n");
}

/** 模块级缓存：本进程内注册成功则不再重复；失败则允许稍后重试。 */
let registrationReady = null;
let lastAttemptAt = 0;
const REGISTER_RETRY_MIN_MS = 10000;

function ensureRegistered(ctx) {
  if (registrationReady !== null) return registrationReady;
  if (!existsSync(PS5)) {
    registrationReady = Promise.resolve(false);
    return registrationReady;
  }
  // 上次失败后 10 秒内不重试，避免反复 spawn
  if (Date.now() - lastAttemptAt < REGISTER_RETRY_MIN_MS) return Promise.resolve(false);
  lastAttemptAt = Date.now();
  log("registration attempt start");
  registrationReady = new Promise((resolve) => {
    runPowerShell(ctx, PS5, registrationScript(), (ok, stderr) => {
      log(`registration attempt done: ok=${ok}`);
      if (ok) {
        ctx.logger.info(`dsh-win-notify: 通知身份 ${APP_ID} 已注册（${SHORTCUT_NAME}）`);
      } else {
        ctx.logger.warn("dsh-win-notify: 通知身份注册失败，将回退到气泡通知，稍后会重试");
        registrationReady = null; // 下次调用重试
      }
      resolve(ok);
    }, "register");
  });
  return registrationReady;
}

function showToast(ctx, cfg, title, body, launch, sessionId) {
  if (suppressFor(sessionId, cfg)) {
    log(`toast suppressed (session in foreground): ${title} | ${body}`);
    return;
  }
  if (!existsSync(PS5)) {
    ctx.logger.warn("dsh-win-notify: 找不到 powershell.exe，无法发送系统通知");
    return;
  }
  const useToast = (registered) => {
    if (registered) {
      log(`toast shown via registered identity: ${title} | ${body} | launch=${launch ?? ""}`);
      runPowerShell(ctx, PS5, toastScript(title, body, cfg.sound, launch), undefined, "toast");
    } else if (process.platform === "win32") {
      log(`toast shown via balloon fallback: ${title} | ${body}`);
      runPowerShell(ctx, "pwsh", balloonScript(title, body), undefined, "balloon");
    }
  };
  // 注册通常 ~2 秒完成；超时则直接走气泡回退，避免阻塞任务完成通知。
  const timeout = new Promise((resolve) => setTimeout(() => resolve(false), 15000));
  Promise.race([ensureRegistered(ctx), timeout]).then(useToast, () => useToast(false));
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!cfg.enabled) return;

  /** agent -> 开始运行的时间戳；仅在 running→idle 且确实运行过时通知。 */
  const runningSince = new Map();

  /** 点击跳转地址：GUI 根地址 + ?session=<会话ID>。subject 为 agent 或 session。 */
  const launchFor = (subject) => {
    if (!cfg.openOnClick) return void 0;
    const session = subject?.session ?? subject;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId === "") return void 0;
    const server = ctx.get("webServer");
    const base = cfg.baseUrl ? cfg.baseUrl : `http://127.0.0.1:${server?.port ?? 3080}`;
    return `${base.replace(/\/$/, "")}/?session=${encodeURIComponent(sessionId)}`;
  };

  const notify = (agent, body) => {
    const prompt = truncate(lastUserPrompt(agent), cfg.maxPromptChars);
    const text = prompt ? `${body}：${prompt}` : body;
    showToast(ctx, cfg, cfg.title, text, launchFor(agent), agent?.session?.id);
  };

  /** approvalId -> 防抖定时器；asked 后超过 approvalWaitMs 仍未 decided 才弹「等待审批」。 */
  const pendingApprovals = new Map();

  /** 从 ask_user_question 的工具调用事件里取第一条问题的文本（arguments 可能是对象或 JSON 字符串）。 */
  const questionTextOf = (event) => {
    try {
      let args = event?.data?.arguments;
      if (typeof args === "string") { try { args = JSON.parse(args); } catch { args = {}; } }
      const q = Array.isArray(args?.questions) ? args.questions[0] : null;
      if (typeof q?.question === "string" && q.question.trim() !== "") return q.question.trim();
      if (typeof q?.header === "string" && q.header.trim() !== "") return q.header.trim();
    } catch { /* 忽略 */ }
    return "";
  };

  /** callId -> 定时器；ask_user_question 后超过 questionWaitMs 仍未收到 tool/result 才弹「等待用户回复」。 */
  const pendingQuestions = new Map();

  const disposeApprovalWatch = ctx.on("session/event", (session, event) => {
    try {
      if (event?.type === "approval/asked") {
        if (!cfg.approval) return;
        const id = event.data?.id;
        if (typeof id !== "string" || id === "") return;
        if (pendingApprovals.has(id)) return;
        const waitMs = Math.max(0, Number(cfg.approvalWaitMs) || 0);
        const timer = setTimeout(() => {
          pendingApprovals.delete(id);
          if (isApprovalDecided(session?.events ?? [], id)) return; // 阈值内已被决定（或策略 never/无应答方），不打扰
          const body = approvalNoticeBody(event, cfg);
          if (body) showToast(ctx, cfg, cfg.title, body, launchFor(session), session?.id);
        }, waitMs);
        pendingApprovals.set(id, timer);
      } else if (event?.type === "approval/decided") {
        const id = event.data?.id;
        if (typeof id !== "string") return;
        const timer = pendingApprovals.get(id);
        if (timer !== undefined) {
          clearTimeout(timer);
          pendingApprovals.delete(id);
        }
      } else if ((event?.type === "tool/call" || event?.type === "tool/code-dispatch-start") && event.data?.name === "ask_user_question") {
        if (!cfg.question) return;
        // code 模式：subCallId 唯一标识该次提问；原生工具：callId
        const key = typeof event.data?.subCallId === "string" && event.data.subCallId !== ""
          ? event.data.subCallId
          : event.data?.callId;
        if (typeof key !== "string" || key === "") return;
        if (pendingQuestions.has(key)) return;
        // 外层调用 id（提问是外层 run_code 的内部调度时，结果以 rootCallId 出现）
        const rootId = typeof event.data?.rootCallId === "string" ? event.data.rootCallId : key;
        const text = questionTextOf(event) || cfg.bodyQuestion;
        const waitMs = Math.max(0, Number(cfg.questionWaitMs) || 0);
        const timer = setTimeout(() => {
          pendingQuestions.delete(key);
          showToast(ctx, cfg, cfg.title, `${cfg.bodyQuestion}：${truncate(text, Math.max(1, Number(cfg.maxQuestionChars) || 80))}`, launchFor(session), session?.id);
        }, waitMs);
        pendingQuestions.set(key, { timer, rootId });
      } else if (event?.type === "tool/result") {
        if (!cfg.question) return;
        const callId = event.data?.message?.source?.callId;
        if (typeof callId !== "string") return;
        // 提问所属调用的结果出现（或匹配提问自身 id）→ 用户已回复/已取消，撤销通知
        for (const [qKey, entry] of pendingQuestions) {
          if (entry.rootId === callId || qKey === callId) {
            clearTimeout(entry.timer);
            pendingQuestions.delete(qKey);
          }
        }
      }
    } catch { /* 通知失败不影响宿主 */ }
  });

  ctx.on("dispose", () => {
    disposeApprovalWatch?.();
    for (const timer of pendingApprovals.values()) clearTimeout(timer);
    pendingApprovals.clear();
    for (const entry of pendingQuestions.values()) clearTimeout(entry.timer);
    pendingQuestions.clear();
  });

  ctx.on("agent/status", ({ status, agent }) => {
    if (status === "running") {
      runningSince.set(agent, Date.now());
      return;
    }
    if (status !== "idle") return;
    const started = runningSince.get(agent);
    runningSince.delete(agent);
    if (started === undefined) return; // 本来就是 idle，无任务完成

    const reason = lastTurnEndReason(agent);
    if (reason?.kind === "aborted") return; // 用户手动停止，不算完成
    if (reason?.kind === "error") {
      if (!cfg.onError) return;
      const message = truncate(reason.error?.message ?? "未知错误", 120);
      notify(agent, `${cfg.bodyError}：${message}`);
      return;
    }
    notify(agent, cfg.body);
  });

  // 浏览器前台状态上报路由（页面聚焦 + 当前选中会话）——抑制前台会话的通知
  // 注意：本行无 inject，apply 时 webServer 服务可能尚未挂载——监听 internal/service 等待它出现再注册。
  let focusRouteRegistered = false;
  const registerFocusRoute = () => {
    if (focusRouteRegistered || !cfg.suppressWhenVisible) return;
    const webServer = ctx.get("webServer");
    if (webServer === undefined) return;
    focusRouteRegistered = true;
    ctx.effect(() => webServer.register({
      kind: "exact",
      path: "/dsh-win-notify/focus",
      handler: (req, res) => {
        try {
          const url = new URL(req.url ?? "/", "http://localhost");
          const focused = url.searchParams.get("focused") === "1";
          const sessionId = url.searchParams.get("session") ?? "";
          const changed = clientView === null || clientView.focused !== focused || clientView.sessionId !== sessionId;
          clientView = { focused, sessionId };
          clientViewAt = Date.now();
          if (changed) log("client view: focused=" + focused + " session=" + (sessionId || "(none)"));
          res.writeHead(204);
        } catch {
          res.writeHead(400);
        }
        res.end();
      }
    }), "dsh-win-notify: focus report route");
  };
  if (cfg.suppressWhenVisible) {
    ctx.on("internal/service", registerFocusRoute);
    registerFocusRoute();
    const focusRetry = setTimeout(registerFocusRoute, 3000);
    ctx.on("dispose", () => clearTimeout(focusRetry));
  }

  log(`apply: enabled, sound=${cfg.sound}, approval=${cfg.approval}, approvalWaitMs=${cfg.approvalWaitMs}`);
  void ensureRegistered(ctx); // 激活即注册，不阻塞
  ctx.logger.info(`dsh-win-notify: 已启用（sound=${cfg.sound}, onError=${cfg.onError}, approval=${cfg.approval}）`);
}
