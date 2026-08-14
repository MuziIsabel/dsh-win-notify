# dsh-win-notify

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that shows a **Windows toast notification with sound** when an agent task finishes.

- App name **DeepSeek** with the official whale icon in the notification
- Notifies when a **top-level** agent turn completes (running → idle); subagent turns stay silent
- Shows the last user prompt in the notification body
- Also notifies on task errors (configurable)
- **Click the notification to switch and foreground a live GUI tab in place** — no transient browser tab; only when no live GUI exists does it open a new one (deep link via `?session=<id>`)
- Also notifies while waiting for user approval on sandbox/permission requests (configurable)
- Also notifies when the agent asks you a question (`ask_user_question`) and waits for your reply (configurable)
- **Focus-aware:** while the GUI page is focused and showing the session that triggered the event, that session's notifications are suppressed — no disturbance when you are already watching
- Tasks you manually stop are **not** treated as completed — no notification
- Pure PowerShell 5.1 (built into Windows) — no extra dependencies

## Requirements

- Windows 10/11
- dsh (DeepSeek Harness) — any profile (web, headless, tui)

## Install

```sh
dsh plugin --profile web add github:MuziIsabel/dsh-win-notify
```

`dsh plugin` forwards to pnpm inside the profile directory; the bundle
reconciles itself into the profile's `dsh.profile.bundles` list. Restart
(or let the profile's HMR apply) the profile for the row to activate.

> The plugin works in any profile — add it to `headless`/other profiles the
> same way if you want notifications there too.

## Uninstall

```sh
dsh plugin --profile web remove dsh-win-notify
```

## Configuration

The bundle inserts a loader row `win-notify` into the profile. Override its
config in the profile's `cordis.patch.yml`:

```yaml
- id: win-notify
  config:
    enabled: true          # enable the plugin (default true)
    sound: default         # default | reminder | sms | alarm | silent
    onError: true          # also notify on task errors (default true)
    openOnClick: true      # click to open/select the GUI session (default true)
    directActivate: true   # deliver to a live loopback GUI tab first; otherwise use browser deep-link
    baseUrl: ''            # custom GUI root URL (default: auto from webServer port)
    approval: true         # notify while waiting for user approval (default true)
    approvalWaitMs: 3000   # how long an approval may pend before notifying
    question: true         # notify while waiting for a user reply (default true)
    questionWaitMs: 3000   # how long a question may pend before notifying
    suppressWhenVisible: true  # suppress notifications for the session you are actively viewing (default true)
    visibilityTtlMs: 25000      # focus-state freshness window (client heartbeats every ~10s)
    title: 'DeepSeek Harness'
    body: '任务已完成'
    bodyError: '任务出错'
    maxPromptChars: 64
```

## How it works

1. **Identity registration (one-time, automatic).** Windows only displays
   toasts from *registered* app identities. On activation the plugin:
   - compiles a tiny `DeepSeek.exe` stub into `%LOCALAPPDATA%\DeepSeek`;
   - creates a Start Menu shortcut `DeepSeek.lnk` pointing at it, with the
     multi-size `DeepSeek.ico` (generated from the official DeepSeek Harness
     favicon) as its icon;
   - writes the `AppUserModelID` (`DSH.WinNotify`) onto the shortcut via
     `IPropertyStore` P/Invoke (the BurntToast technique).
   Toasts then display as **DeepSeek** with the whale icon. The shortcut is
   the identity carrier — do not delete it; the plugin recreates it if missing.
2. **Event hook.** The plugin listens on the host plane for `agent/status`
   events. When a session's agent transitions `running` → `idle`, it checks
   the session log's last `turn/end` reason: `completed` → notification,
   `error` → error notification (if enabled), `aborted` (manual stop) → skip.
3. **Notification.** Spawns `powershell.exe` (Windows PowerShell 5.1, which
   has WinRT projection) with a UTF-16LE `-EncodedCommand` script that shows a
   `ToastNotification` with an `ms-winsoundevent` audio element, so Chinese
   text is never garbled. If registration fails, it falls back to a
   `NotifyIcon` balloon.
4. **Click-to-open without a transient tab.** On loopback GUI URLs, the
   registered `dsh-win-notify://` protocol starts the small local
   `DeepSeek.exe` helper rather than a browser. It asks the local DSH server
   to deliver an `open-session` command to the most recently focused live GUI
   tab; that tab calls `sessions.open(id)` in place (no full-page refresh and
   no new browser tab). After a successful acknowledgement, the helper makes a
   best-effort Windows UI Automation selection of the matching Chrome/Edge tab,
   so a click made while you are browsing another tab can bring the DSH tab to
   the foreground. The helper matches the tab by its post-switch title, with a
   race-proof app-name fallback, and preserves maximized or normally sized
   browser windows; only minimized windows are restored. Browser accessibility,
   elevation,
   virtual-desktop, and focus-stealing policy can still prevent foregrounding;
   in that case the session is nevertheless selected in the background. If no live GUI
   acknowledges promptly, or the protocol registration is unavailable, the
   helper safely falls back to the normal `<gui>/?session=<id>` deep link; its
   `BroadcastChannel` handoff remains a second fallback. The first
   custom-protocol click can require a one-time browser/Windows confirmation.
   Non-loopback custom `baseUrl` values keep the normal HTTP deep link for
   safety.

## Troubleshooting

- **No notifications:** check Windows Settings → System → Notifications →
  `DSH.WinNotify` is enabled. Also make sure the Start Menu shortcut
  `DeepSeek.lnk` exists.
- **Diagnostics:** the plugin appends a log line for every registration
  attempt and notification at `$DSH_HOME/dsh-win-notify.log`.

## License

MIT. The notification icon is derived from the DeepSeek Harness favicon
(`@deepseek-ai/dsh-web-frontend`, MIT © DeepSeek).
