# dsh-win-notify

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that shows a **Windows toast notification with sound** when an agent task finishes.

- App name **DeepSeek** with the official whale icon in the notification
- Notifies when an agent turn completes (running → idle)
- Shows the last user prompt in the notification body
- Also notifies on task errors (configurable)
- Also notifies when an agent is **waiting for user approval** (sandbox
escalation etc.), after a configurable delay — quickly auto-decided requests stay quiet
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
    title: 'DeepSeek Harness'
    body: '任务已完成'
    bodyError: '任务出错'
    maxPromptChars: 64
    approval: true         # notify when waiting for user approval (default true)
    approvalWaitMs: 3000   # notify only if still undecided after this delay (ms)
    bodyApproval: '等待用户审批'
    maxReasonChars: 80     # max length of the approval reason shown
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
4. **Approval waiting.** When the harness asks the user to approve an action
   (sandbox escalation etc.), the session log records `approval/asked`;
   the matching `approval/decided` closes it. The plugin listens on the host
   plane for `session/event`: after `approvalWaitMs` (default 3000 ms) it
   checks whether the ask is still undecided and, if so, shows a
   "等待用户审批" toast with the tool name and the approval reason.
   Asks that get decided within the delay (no answerer / `never` policy /
   quick user response) never trigger a notification.

## Troubleshooting

- **No notifications:** check Windows Settings → System → Notifications →
  `DSH.WinNotify` is enabled. Also make sure the Start Menu shortcut
  `DeepSeek.lnk` exists.
- **Diagnostics:** the plugin appends a log line for every registration
  attempt and notification at `$DSH_HOME/dsh-win-notify.log`.

## License

MIT. The notification icon is derived from the DeepSeek Harness favicon
(`@deepseek-ai/dsh-web-frontend`, MIT © DeepSeek).
