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
import { randomBytes } from "node:crypto";
import { existsSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
  // 点击 Toast 时优先通过本地协议直接唤醒已有 GUI 标签（无标签时才打开浏览器）
  directActivate: z.boolean().default(true),
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
  directActivate: true,
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
const STUB_VERSION = "6";
const ACTIVATION_SCHEME = "dsh-win-notify";
const ICON_FILE = "DeepSeek.ico";
/** 每个宿主进程的激活密钥；仅 Toast 的本地协议处理器持有。 */
const ACTIVATION_TOKEN = randomBytes(24).toString("base64url");
const PLUGIN_DIR = fileURLToPath(new URL(".", import.meta.url));
const ICON_SOURCE = join(PLUGIN_DIR, "assets", ICON_FILE);
const LOG_FILE = join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), "dsh-win-notify.log");
function log(msg) {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] pid=${process.pid} ${msg}\n`); } catch { /* 忽略日志错误 */ }
}
log("module loaded"); // 模块被 import 时立即记录

/** 浏览器前台状态表：clientId -> { focused, sessionId, at }。按客户端分组，多标签页互不覆盖。 */
const clientViews = new Map();

/** 该会话是否正被任一前台（聚焦）标签页查看——是则不打扰。 */
function suppressFor(sessionId, cfg) {
  if (!cfg.suppressWhenVisible) return false;
  if (typeof sessionId !== "string" || sessionId === "") return false;
  const now = Date.now();
  const ttl = Math.max(5000, Number(cfg.visibilityTtlMs) || 25000);
  for (const [clientId, view] of clientViews) {
    if (now - view.at > ttl) { clientViews.delete(clientId); continue; } // 标签页关闭/心跳超时
    if (view.focused === true && view.sessionId === sessionId) return true;
  }
  return false;
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

/** Windows 自定义协议处理器：把 Toast 点击先交给本机 GUI；无法交接时再打开浏览器。 */
const ACTIVATION_STUB_CS = String.raw`using System;
using System.Diagnostics;
using System.Net;
using System.Text;
using System.Threading;
using System.Runtime.InteropServices;
using System.Windows.Automation;

internal sealed class TimedWebClient : WebClient
{
    protected override WebRequest GetWebRequest(Uri address)
    {
        WebRequest request = base.GetWebRequest(address);
        request.Timeout = 4000;
        return request;
    }
}

internal static class Program
{
    private static string QueryValue(Uri uri, string name)
    {
        string query = uri == null ? "" : uri.Query;
        if (String.IsNullOrEmpty(query)) return "";
        foreach (string part in query.TrimStart('?').Split('&'))
        {
            int equals = part.IndexOf('=');
            string rawKey = equals < 0 ? part : part.Substring(0, equals);
            string key;
            try { key = Uri.UnescapeDataString(rawKey); } catch { continue; }
            if (!String.Equals(key, name, StringComparison.OrdinalIgnoreCase)) continue;
            string rawValue = equals < 0 ? "" : part.Substring(equals + 1);
            try { return Uri.UnescapeDataString(rawValue.Replace("+", " ")); } catch { return ""; }
        }
        return "";
    }

    private static bool IsLoopbackHttp(Uri uri)
    {
        if (uri == null || (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps)) return false;
        if (!String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment)) return false;
        string host = uri.Host;
        return String.Equals(host, "127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || String.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)
            || String.Equals(host, "::1", StringComparison.OrdinalIgnoreCase)
            || String.Equals(host, "[::1]", StringComparison.OrdinalIgnoreCase);
    }

    private static void OpenBrowser(string url)
    {
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true }); } catch { }
    }

    private static string JsonAsciiValue(string json, string name)
    {
        if (String.IsNullOrEmpty(json) || String.IsNullOrEmpty(name)) return "";
        string prefix = "\"" + name + "\":\"";
        int start = json.IndexOf(prefix, StringComparison.OrdinalIgnoreCase);
        if (start < 0) return "";
        start += prefix.Length;
        int end = json.IndexOf('\"', start);
        return end < start ? "" : json.Substring(start, end - start);
    }

    private static string DecodeBase64Url(string value)
    {
        try
        {
            string text = (value ?? "").Replace('-', '+').Replace('_', '/');
            while ((text.Length % 4) != 0) text += "=";
            return Encoding.UTF8.GetString(Convert.FromBase64String(text));
        }
        catch { return ""; }
    }

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr hWnd);

    private static bool IsChromiumWindow(AutomationElement window)
    {
        try
        {
            string name = Process.GetProcessById(window.Current.ProcessId).ProcessName;
            return String.Equals(name, "chrome", StringComparison.OrdinalIgnoreCase)
                || String.Equals(name, "msedge", StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static bool MatchesTabTitle(string actual, string expected)
    {
        if (String.IsNullOrEmpty(actual) || String.IsNullOrEmpty(expected)) return false;
        return String.Equals(actual, expected, StringComparison.Ordinal)
            || actual.StartsWith(expected + " - ", StringComparison.Ordinal);
    }

    // GUI tab titles always end with the app name; use it as a race-proof fallback marker.
    private const string AppTitleMarker = "DeepSeek Harness";

    private static void BringBrowserWindowForward(AutomationElement window)
    {
        try
        {
            int handle = window.Current.NativeWindowHandle;
            if (handle == 0) return;
            // SW_RESTORE un-maximizes a maximized window; only restore minimized ones.
            IntPtr pointer = new IntPtr(handle);
            if (IsIconic(pointer)) ShowWindow(pointer, 9); // SW_RESTORE
            SetForegroundWindow(pointer);
        }
        catch { }
    }

    private static bool SelectTabElement(AutomationElement tab)
    {
        object pattern;
        if (tab.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            ((SelectionItemPattern)pattern).Select();
        else
            tab.SetFocus();
        return true;
    }

    private static bool SelectTabInWindow(AutomationElement window, string title)
    {
        try
        {
            AutomationElementCollection tabs = window.FindAll(
                TreeScope.Descendants,
                new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.TabItem));
            AutomationElement fallback = null;
            foreach (AutomationElement tab in tabs)
            {
                string name = tab.Current.Name ?? "";
                if (title.Length > 0 && MatchesTabTitle(name, title)) return SelectTabElement(tab);
                if (fallback == null && name.IndexOf(AppTitleMarker, StringComparison.Ordinal) >= 0) fallback = tab;
            }
            // In-place session switches rename the tab before we enumerate it; any tab
            // carrying the app marker is still the GUI tab that handled the activation.
            if (fallback != null) return SelectTabElement(fallback);
        }
        catch { }
        return false;
    }

    // Browser page-side focus is restricted; try the current Chromium window first.
    // Any failure leaves the already-switched session intact and preserves HTTP fallback.
    private static void ActivateBrowserTab(string title)
    {
        if (String.IsNullOrEmpty(title)) return;
        try
        {
            IntPtr foreground = GetForegroundWindow();
            if (foreground != IntPtr.Zero)
            {
                AutomationElement current = AutomationElement.FromHandle(foreground);
                if (current != null && IsChromiumWindow(current))
                {
                    BringBrowserWindowForward(current);
                    if (SelectTabInWindow(current, title)) return;
                }
            }
            for (int attempt = 0; attempt < 5; attempt++)
            {
                AutomationElementCollection windows = AutomationElement.RootElement.FindAll(
                    TreeScope.Children,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Window));
                foreach (AutomationElement window in windows)
                {
                    if (!IsChromiumWindow(window)) continue;
                    if (window.Current.NativeWindowHandle == foreground.ToInt32()) continue;
                    // Select a matching tab exposed by a background window's accessibility tree.
                    if (!SelectTabInWindow(window, title)) continue;
                    BringBrowserWindowForward(window);
                    return;
                }
                Thread.Sleep(120);
            }
        }
        catch { }
    }

    [STAThread]
    public static void Main(string[] args)
    {
        if (args == null || args.Length == 0) return;
        Uri activation;
        if (!Uri.TryCreate(args[0], UriKind.Absolute, out activation)
            || !String.Equals(activation.Scheme, "dsh-win-notify", StringComparison.OrdinalIgnoreCase)) return;
        string baseText = QueryValue(activation, "base");
        string sessionId = QueryValue(activation, "session");
        string token = QueryValue(activation, "token");
        Uri baseUri;
        if (String.IsNullOrEmpty(sessionId) || String.IsNullOrEmpty(token)
            || !Uri.TryCreate(baseText, UriKind.Absolute, out baseUri) || !IsLoopbackHttp(baseUri)) return;
        string baseUrl = baseText.TrimEnd('/');
        string browserUrl = baseUrl + "/?session=" + Uri.EscapeDataString(sessionId);
        bool handled = false;
        string focusTitle = "";
        try
        {
            string endpoint = baseUrl + "/dsh-win-notify/activate?session=" + Uri.EscapeDataString(sessionId)
                + "&token=" + Uri.EscapeDataString(token);
            using (TimedWebClient client = new TimedWebClient())
            {
                client.Proxy = null;
                client.Encoding = Encoding.UTF8;
                string response = client.UploadString(endpoint, "POST", "");
                handled = response.IndexOf("\"handled\":true", StringComparison.OrdinalIgnoreCase) >= 0;
                if (handled) focusTitle = DecodeBase64Url(JsonAsciiValue(response, "focus"));
            }
        }
        catch { }
        if (handled)
        {
            ActivateBrowserTab(focusTitle);
            return;
        }
        OpenBrowser(browserUrl);
    }
}`;

/** 身份和本地协议注册脚本（幂等）：无控制台的处理器 + 图标 + 快捷方式 + AUMID。 */
function registrationScript() {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$appDir = Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)) '" + APP_DIR_NAME + "'",
    "New-Item -ItemType Directory -Force -Path $appDir | Out-Null",
    "$exe = Join-Path $appDir '" + STUB_EXE + "'",
    "$schemeReady = $false",
    "try {",
    "$versionFile = Join-Path $appDir '" + STUB_EXE + ".version'",
    "$needsStub = -not (Test-Path $exe) -or -not (Test-Path $versionFile) -or ((Get-Content -LiteralPath $versionFile -Raw).Trim() -ne '" + STUB_VERSION + "')",
    "if ($needsStub) {",
    "  $tmp = Join-Path $appDir 'DeepSeek.next.exe'",
    "  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Force }",
    "  $runtime = [Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()",
    "  $automationRefs = @((Join-Path $runtime 'WPF\UIAutomationClient.dll'), (Join-Path $runtime 'WPF\UIAutomationTypes.dll'))",
    "  Add-Type -TypeDefinition @'",
    ACTIVATION_STUB_CS,
    "'@ -OutputAssembly $tmp -OutputType WindowsApplication -ReferencedAssemblies $automationRefs",
    "  $replaced = $false",
    "  $replaceAttempts = 0",
    "  do {",
    "    try {",
    "      Copy-Item -LiteralPath $tmp -Destination $exe -Force",
    "      $replaced = $true",
    "    } catch {",
    "      $replaceAttempts++",
    "      if ($replaceAttempts -ge 5) { throw }",
    "      Start-Sleep -Milliseconds 300",
    "    }",
    "  } while (-not $replaced)",
    "  Remove-Item -LiteralPath $tmp -Force",
    "  Set-Content -LiteralPath $versionFile -Value '" + STUB_VERSION + "' -NoNewline",
    "}",
    "Copy-Item '" + ICON_SOURCE + "' (Join-Path $appDir '" + ICON_FILE + "') -Force",
    "$protocolKey = 'HKCU:\\Software\\Classes\\" + ACTIVATION_SCHEME + "'",
    "New-Item -Path $protocolKey -Force | Out-Null",
    "Set-Item -Path $protocolKey -Value 'URL:DeepSeek Harness notification activation'",
    "New-ItemProperty -Path $protocolKey -Name 'URL Protocol' -PropertyType String -Value '' -Force | Out-Null",
    "$protocolIconKey = Join-Path $protocolKey 'DefaultIcon'",
    "New-Item -Path $protocolIconKey -Force | Out-Null",
    "Set-Item -Path $protocolIconKey -Value ((Join-Path $appDir '" + ICON_FILE + "') + ',0')",
    "$protocolCommandKey = Join-Path $protocolKey 'shell\\open\\command'",
    "New-Item -Path $protocolCommandKey -Force | Out-Null",
    "Set-Item -Path $protocolCommandKey -Value ('\"' + $exe + '\" \"%1\"')",
    "$schemeReady = $true",
    "} catch {",
    "  Write-Output 'scheme=0'",
    "}",
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
    "Write-Output ('registered scheme=' + $(if ($schemeReady) { '1' } else { '0' }))",
  ].join("\n");
}

/** 启动一个独立的 PowerShell 进程执行脚本（fire-and-forget）。 */
const MAX_INLINE_ENCODED_COMMAND_CHARS = 24000;
function runPowerShell(ctx, executable, script, onDone, label) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  let scriptPath = "";
  let args;
  try {
    if (encoded.length <= MAX_INLINE_ENCODED_COMMAND_CHARS) {
      args = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    } else {
      // Windows has a ~32K command-line ceiling. Keep large registration C# out
      // of argv, preserving Unicode with a UTF-16LE BOM script file instead.
      scriptPath = join(tmpdir(), "dsh-win-notify-" + process.pid + "-" + randomBytes(8).toString("hex") + ".ps1");
      writeFileSync(scriptPath, "\ufeff" + script, "utf16le");
      args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath];
      log("large PowerShell script staged: " + (label ?? "unnamed"));
    }
  } catch (error) {
    log("stage fail " + label + ": " + error.message);
    ctx.logger.warn("dsh-win-notify: 无法准备通知进程脚本: " + error.message);
    onDone?.(false, "");
    return;
  }
  const cleanup = () => {
    if (scriptPath === "") return;
    try { unlinkSync(scriptPath); } catch { /* 临时脚本可由系统清理 */ }
    scriptPath = "";
  };
  let child;
  try {
    child = spawn(executable, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch (error) {
    cleanup();
    log("spawn fail " + label + ": " + error.message);
    ctx.logger.warn("dsh-win-notify: 无法启动通知进程 " + executable + ": " + error.message);
    onDone?.(false, "");
    return;
  }
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
  child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
  let failed = false;
  child.on("error", (error) => {
    failed = true;
    cleanup();
    log("process error " + label + ": " + error.message);
    ctx.logger.warn("dsh-win-notify: 通知进程错误: " + error.message);
    onDone?.(false, stderr, stdout);
  });
  child.on("exit", (code) => {
    cleanup();
    log("exit " + label + ": code=" + code + " stderr=" + stderr.slice(0, 600).replace(/\s+/g, " "));
    if (code !== 0 && !failed) {
      ctx.logger.warn("dsh-win-notify: 通知进程退出码 " + code);
      onDone?.(false, stderr, stdout);
      return;
    }
    onDone?.(code === 0, stderr, stdout);
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

/** DSH 只为子代理持久化 header.origin = "subagent"；普通 fork 不会带该标记。 */
function isSubagent(subject) {
  try {
    const session = subject?.session ?? subject;
    return session?.header?.origin === "subagent";
  } catch {
    return false;
  }
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
    registrationReady = Promise.resolve({ toast: false, scheme: false });
    return registrationReady;
  }
  // 上次失败后 10 秒内不重试，避免反复 spawn
  if (Date.now() - lastAttemptAt < REGISTER_RETRY_MIN_MS) return Promise.resolve({ toast: false, scheme: false });
  lastAttemptAt = Date.now();
  log("registration attempt start");
  registrationReady = new Promise((resolve) => {
    runPowerShell(ctx, PS5, registrationScript(), (ok, stderr, stdout) => {
      const scheme = ok && /(?:^|\s)scheme=1(?:\s|$)/.test(stdout ?? "");
      log(`registration attempt done: toast=${ok} scheme=${scheme}`);
      if (ok) {
        ctx.logger.info(`dsh-win-notify: 通知身份 ${APP_ID} 已注册（${SHORTCUT_NAME}，direct=${scheme}）`);
      } else {
        ctx.logger.warn("dsh-win-notify: 通知身份注册失败，将回退到气泡通知，稍后会重试");
        registrationReady = null; // 下次调用重试
      }
      resolve({ toast: ok, scheme });
    }, "register");
  });
  return registrationReady;
}

function showToast(ctx, cfg, title, body, launchFactory, sessionId) {
  if (suppressFor(sessionId, cfg)) {
    log(`toast suppressed (session in foreground): ${title} | ${body}`);
    return;
  }
  if (!existsSync(PS5)) {
    ctx.logger.warn("dsh-win-notify: 找不到 powershell.exe，无法发送系统通知");
    return;
  }
  const useToast = (registration) => {
    if (registration.toast) {
      const launch = typeof launchFactory === "function" ? launchFactory(registration.scheme) : launchFactory;
      const launchLog = typeof launch === "string" && launch.startsWith(ACTIVATION_SCHEME + ":")
        ? ACTIVATION_SCHEME + "://…"
        : launch ?? "";
      log(`toast shown via registered identity: ${title} | ${body} | launch=${launchLog}`);
      runPowerShell(ctx, PS5, toastScript(title, body, cfg.sound, launch), undefined, "toast");
    } else if (process.platform === "win32") {
      log(`toast shown via balloon fallback: ${title} | ${body}`);
      runPowerShell(ctx, "pwsh", balloonScript(title, body), undefined, "balloon");
    }
  };
  // 注册通常 ~2 秒完成；超时则直接走气泡回退，避免阻塞任务完成通知。
  const timeout = new Promise((resolve) => setTimeout(() => resolve({ toast: false, scheme: false }), 15000));
  Promise.race([ensureRegistered(ctx), timeout]).then(useToast, () => useToast({ toast: false, scheme: false }));
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config };
  if (!cfg.enabled) return;

  /** agent -> 开始运行的时间戳；仅在 running→idle 且确实运行过时通知。 */
  const runningSince = new Map();

  /** GUI 根地址与传统 HTTP 深链；原生处理器交接失败时仍由它兜底。 */
  const guiBase = () => {
    const server = ctx.get("webServer");
    const base = cfg.baseUrl ? cfg.baseUrl : `http://127.0.0.1:${server?.port ?? 3080}`;
    return base.replace(/\/$/, "");
  };
  const isLoopbackBase = (base) => {
    try {
      const url = new URL(base);
      return (url.protocol === "http:" || url.protocol === "https:")
        && (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname === "::1")
        && url.search === "" && url.hash === "";
    } catch {
      return false;
    }
  };
  const browserLaunchFor = (sessionId, base = guiBase()) => `${base}/?session=${encodeURIComponent(sessionId)}`;
  /** 点击跳转：本机协议优先交给已有 GUI；非环回自定义地址仍保持浏览器深链。 */
  const launchFor = (subject, useDirect = true) => {
    if (!cfg.openOnClick) return void 0;
    const session = subject?.session ?? subject;
    const sessionId = session?.id;
    if (typeof sessionId !== "string" || sessionId === "") return void 0;
    const base = guiBase();
    const browser = browserLaunchFor(sessionId, base);
    if (!useDirect || !cfg.directActivate || !isLoopbackBase(base)) return browser;
    return `${ACTIVATION_SCHEME}://activate?base=${encodeURIComponent(base)}&session=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(ACTIVATION_TOKEN)}`;
  };

  /** 原生协议 → 已有浏览器标签页的单次命令队列。 */
  const queuedCommands = new Map(); // clientId -> { id, sessionId, at }
  const commandPolls = new Map(); // clientId -> { res, timer }
  const activationAcks = new Map(); // commandId -> { clientId, resolve, timer }
  const COMMAND_POLL_WAIT_MS = 25000;
  const ACTIVATION_ACK_WAIT_MS = 2800;
  const writeJson = (res, status, value) => {
    if (res.destroyed || res.writableEnded) return;
    const body = JSON.stringify(value);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
  };
  const focusTitle = (value) => typeof value === "string" ? value.trim().slice(0, 512) : "";
  const focusToken = (title) => {
    const value = focusTitle(title);
    return value === "" ? "" : Buffer.from(value, "utf8").toString("base64url");
  };
  const settleActivation = (commandId, handled, title = "") => {
    const entry = activationAcks.get(commandId);
    if (entry === void 0) return false;
    activationAcks.delete(commandId);
    clearTimeout(entry.timer);
    entry.resolve({ handled, title: handled ? (focusTitle(entry.title) || focusTitle(title)) : "" });
    return true;
  };
  const finishPoll = (clientId, entry, value) => {
    if (commandPolls.get(clientId) !== entry) return;
    commandPolls.delete(clientId);
    clearTimeout(entry.timer);
    writeJson(entry.res, 200, value);
  };
  const flushCommand = (clientId) => {
    const command = queuedCommands.get(clientId);
    const poll = commandPolls.get(clientId);
    if (command === void 0 || poll === void 0) return false;
    if (poll.res.destroyed || poll.res.writableEnded) {
      commandPolls.delete(clientId);
      clearTimeout(poll.timer);
      return false;
    }
    queuedCommands.delete(clientId);
    finishPoll(clientId, poll, { command: { id: command.id, sessionId: command.sessionId } });
    return true;
  };
  const chooseLiveClient = () => {
    const now = Date.now();
    const ttl = Math.max(5000, Number(cfg.visibilityTtlMs) || 25000);
    const candidates = [];
    for (const [clientId, view] of clientViews) {
      if (view === void 0 || now - Number(view.at) > ttl) {
        clientViews.delete(clientId);
        continue;
      }
      candidates.push({ clientId, view });
    }
    candidates.sort((a, b) => Number(Boolean(b.view.focused)) - Number(Boolean(a.view.focused)) || Number(b.view.at) - Number(a.view.at));
    return candidates[0];
  };
  const enqueueActivation = (clientId, sessionId, title = "") => {
    for (const [id, entry] of activationAcks) if (entry.clientId === clientId) settleActivation(id, false);
    const previous = queuedCommands.get(clientId);
    if (previous !== void 0) queuedCommands.delete(clientId);
    const command = { id: randomBytes(12).toString("hex"), sessionId, at: Date.now() };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (queuedCommands.get(clientId)?.id === command.id) queuedCommands.delete(clientId);
        settleActivation(command.id, false);
      }, ACTIVATION_ACK_WAIT_MS);
      activationAcks.set(command.id, { clientId, title: focusTitle(title), resolve, timer });
      queuedCommands.set(clientId, command);
      flushCommand(clientId);
    });
  };

  const notify = (agent, body) => {
    if (isSubagent(agent)) return;
    const prompt = truncate(lastUserPrompt(agent), cfg.maxPromptChars);
    const text = prompt ? `${body}：${prompt}` : body;
    showToast(ctx, cfg, cfg.title, text, (useDirect) => launchFor(agent, useDirect), agent?.session?.id);
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
    if (isSubagent(session)) return;
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
          if (body) showToast(ctx, cfg, cfg.title, body, (useDirect) => launchFor(session, useDirect), session?.id);
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
          showToast(ctx, cfg, cfg.title, `${cfg.bodyQuestion}：${truncate(text, Math.max(1, Number(cfg.maxQuestionChars) || 80))}`, (useDirect) => launchFor(session, useDirect), session?.id);
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
    if (isSubagent(agent)) return;
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

  // 浏览器前台状态、命令长轮询与原生协议激活路由。
  // 不依赖 suppressWhenVisible：即使关闭通知抑制，也要能将 Toast 点击交给已有 GUI。
  const validId = (value) => typeof value === "string" && value !== "" && value.length <= 512;
  const isLoopbackRequest = (req) => {
    const address = String(req.socket?.remoteAddress ?? "");
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
  };
  let clientRoutesRegistered = false;
  const registerClientRoutes = () => {
    if (clientRoutesRegistered) return;
    const webServer = ctx.get("webServer");
    if (webServer === void 0) return;
    clientRoutesRegistered = true;
    ctx.effect(() => {
      const unregisterFocus = webServer.register({
        kind: "exact",
        path: "/dsh-win-notify/focus",
        handler: (req, res) => {
          try {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            const url = new URL(req.url ?? "/", "http://localhost");
            const focused = url.searchParams.get("focused") === "1";
            const sessionId = url.searchParams.get("session") ?? "";
            const title = focusTitle(url.searchParams.get("title"));
            const clientId = url.searchParams.get("client") ?? "";
            if (!validId(clientId) || sessionId.length > 512) { res.writeHead(400); res.end(); return; }
            const previous = clientViews.get(clientId);
            const changed = previous === void 0 || previous.focused !== focused || previous.sessionId !== sessionId || previous.title !== title;
            clientViews.set(clientId, { focused, sessionId, title, at: Date.now() });
            if (changed) log("client view: client=" + clientId.slice(0, 8) + " focused=" + focused + " session=" + (sessionId || "(none)"));
            res.writeHead(204);
          } catch {
            res.writeHead(400);
          }
          res.end();
        },
      });
      const unregisterCommands = webServer.register({
        kind: "exact",
        path: "/dsh-win-notify/commands",
        handler: (req, res) => {
          try {
            if (req.method !== "GET") { writeJson(res, 405, { command: null }); return; }
            const url = new URL(req.url ?? "/", "http://localhost");
            const clientId = url.searchParams.get("client") ?? "";
            if (!validId(clientId)) { writeJson(res, 400, { command: null }); return; }
            const queued = queuedCommands.get(clientId);
            if (queued !== void 0) {
              queuedCommands.delete(clientId);
              writeJson(res, 200, { command: { id: queued.id, sessionId: queued.sessionId } });
              return;
            }
            const previous = commandPolls.get(clientId);
            if (previous !== void 0) finishPoll(clientId, previous, { command: null });
            const entry = { res, timer: void 0 };
            entry.timer = setTimeout(() => finishPoll(clientId, entry, { command: null }), COMMAND_POLL_WAIT_MS);
            commandPolls.set(clientId, entry);
            req.once("close", () => {
              if (commandPolls.get(clientId) !== entry) return;
              commandPolls.delete(clientId);
              clearTimeout(entry.timer);
            });
          } catch {
            writeJson(res, 400, { command: null });
          }
        },
      });
      const unregisterAck = webServer.register({
        kind: "exact",
        path: "/dsh-win-notify/ack",
        handler: (req, res) => {
          try {
            if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
            const url = new URL(req.url ?? "/", "http://localhost");
            const clientId = url.searchParams.get("client") ?? "";
            const commandId = url.searchParams.get("command") ?? "";
            const entry = activationAcks.get(commandId);
            if (!validId(clientId) || !validId(commandId) || entry === void 0 || entry.clientId !== clientId) { res.writeHead(404); res.end(); return; }
            if (queuedCommands.get(clientId)?.id === commandId) queuedCommands.delete(clientId);
            const ok = url.searchParams.get("ok") === "1";
            const title = focusTitle(url.searchParams.get("title"));
            settleActivation(commandId, ok, title);
            log("direct activation ack: client=" + clientId.slice(0, 8) + " ok=" + ok);
            res.writeHead(204);
          } catch {
            res.writeHead(400);
          }
          res.end();
        },
      });
      const unregisterActivation = webServer.register({
        kind: "exact",
        path: "/dsh-win-notify/activate",
        handler: async (req, res) => {
          try {
            if (req.method !== "POST") { writeJson(res, 405, { handled: false }); return; }
            const url = new URL(req.url ?? "/", "http://localhost");
            const sessionId = url.searchParams.get("session") ?? "";
            if (!isLoopbackRequest(req) || !cfg.openOnClick || !cfg.directActivate || url.searchParams.get("token") !== ACTIVATION_TOKEN || !validId(sessionId)) {
              writeJson(res, 403, { handled: false });
              return;
            }
            const target = chooseLiveClient();
            if (target === void 0) {
              log("direct activation fallback: no live GUI for session=" + sessionId);
              writeJson(res, 200, { handled: false });
              return;
            }
            if (target.view.focused === true && target.view.sessionId === sessionId) {
              writeJson(res, 200, { handled: true, focus: focusToken(target.view.title) });
              return;
            }
            log("direct activation queued: client=" + target.clientId.slice(0, 8) + " session=" + sessionId);
            const result = await enqueueActivation(target.clientId, sessionId, target.view.title);
            // 标签标题在会话切换并重新渲染后才更新；短暂等待客户端补报的新标题，
            // 否则原生助手会拿着旧标题去找标签而落空（标题竞态）。
            let title = result.title;
            if (result.handled) {
              const previous = focusTitle(result.title);
              const deadline = Date.now() + 1000;
              while (Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                const view = clientViews.get(target.clientId);
                if (view === void 0 || view.sessionId !== sessionId) continue;
                const updated = focusTitle(view.title);
                if (updated !== "" && updated !== previous) { title = updated; break; }
              }
            }
            writeJson(res, 200, { handled: result.handled, focus: focusToken(title) });
          } catch {
            writeJson(res, 500, { handled: false });
          }
        },
      });
      return () => {
        unregisterFocus();
        unregisterCommands();
        unregisterAck();
        unregisterActivation();
      };
    }, "dsh-win-notify: client activation routes");
  };
  ctx.on("internal/service", registerClientRoutes);
  registerClientRoutes();
  const routeRetry = setTimeout(registerClientRoutes, 3000);
  ctx.on("dispose", () => {
    clearTimeout(routeRetry);
    for (const entry of commandPolls.values()) {
      clearTimeout(entry.timer);
      try { entry.res.end(); } catch { /* 忽略 */ }
    }
    commandPolls.clear();
    queuedCommands.clear();
    for (const commandId of [...activationAcks.keys()]) settleActivation(commandId, false);
  });

  log(`apply: enabled, sound=${cfg.sound}, approval=${cfg.approval}, approvalWaitMs=${cfg.approvalWaitMs}`);
  void ensureRegistered(ctx); // 激活即注册，不阻塞
  ctx.logger.info(`dsh-win-notify: 已启用（sound=${cfg.sound}, onError=${cfg.onError}, approval=${cfg.approval}）`);
}
