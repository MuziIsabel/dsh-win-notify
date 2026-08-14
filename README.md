# dsh-win-notify

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) plugin that shows a **Windows toast notification with sound** when an agent task finishes.

- App name **DeepSeek** with the official whale icon in the notification
- Notifies when an agent turn completes (running → idle)
- Shows the last user prompt in the notification body
- Also notifies on task errors (configurable)
- **Click the notification to open the GUI and jump straight to that session** (deep link via `?session=<id>`)
- Also notifies while waiting for user approval on sandbox/permission requests (configurable)
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
    openOnClick: true      # click to open the GUI at that session (default true)
    baseUrl: ''            # custom GUI root URL (default: auto from webServer port)
    approval: true         # notify while waiting for user approval (default true)
    approvalWaitMs: 3000   # how long an approval may pend before notifying
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
4. **Click-to-open.** The toast carries `activationType="protocol"` with a
   `launch` URL (`<gui>/?session=<id>`). Clicking opens the default browser at
   the GUI; a small client plugin (`client.js`, declared via `dsh.client`)
   reads the `session` parameter, calls `sessions.open(id)`, and strips the
   parameter so a refresh does not re-trigger. Requires the browser page to be
   loaded after the plugin row is added.

## Troubleshooting

- **No notifications:** check Windows Settings → System → Notifications →
  `DSH.WinNotify` is enabled. Also make sure the Start Menu shortcut
  `DeepSeek.lnk` exists.
- **Diagnostics:** the plugin appends a log line for every registration
  attempt and notification at `$DSH_HOME/dsh-win-notify.log`.

## License

MIT. The notification icon is derived from the DeepSeek Harness favicon
(`@deepseek-ai/dsh-web-frontend`, MIT © DeepSeek).
