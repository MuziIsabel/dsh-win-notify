# dsh-win-notify

简体中文（默认） | [English](README.en.md)

一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件：代理任务完成时在 Windows 上弹出**带声音的 Toast 通知**。

- 通知显示应用名 **DeepSeek** 与官方鲸鱼图标
- **顶层**代理回合完成（running → idle）时通知；子代理回合保持静默
- 通知正文显示最近一条用户提示词
- 任务出错时也会通知（可配置）
- **点击通知直接切换并前台显示现有 GUI 标签** —— 不产生临时浏览器标签；仅当没有存活 GUI 时才新开标签（`?session=<id>` 深链）
- 等待沙箱/权限审批时也会通知（可配置）
- 代理通过 `ask_user_question` 提问等待回复时也会通知（可配置）
- **聚焦感知：** GUI 页面处于前台且正显示触发事件的会话时，抑制该会话的通知 —— 你正在查看时不会被打扰
- 手动停止的任务**不算**完成 —— 不弹通知
- 仅依赖 Windows 自带的 PowerShell 5.1 —— 无额外依赖

## 环境要求

- Windows 10/11
- dsh（DeepSeek Harness）—— 任意 profile（web、headless、tui）

## 安装

```sh
dsh plugin --profile web add github:MuziIsabel/dsh-win-notify
```

`dsh plugin` 会在 profile 目录内转发给 pnpm；bundle 会把自身合并进 profile 的 `dsh.profile.bundles` 列表。重启 profile（或让 profile 的 HMR 生效）即可激活。

> 插件适用于任意 profile —— 如需在其他 profile 收到通知，可用同样的方式添加到 `headless` 等 profile。

## 卸载

```sh
dsh plugin --profile web remove dsh-win-notify
```

## 配置

bundle 会在 profile 中插入加载行 `win-notify`。在 profile 的 `cordis.patch.yml` 中覆盖其配置：

```yaml
- id: win-notify
  config:
    enabled: true          # 启用插件（默认 true）
    sound: default         # default | reminder | sms | alarm | silent
    onError: true          # 任务出错时也通知（默认 true）
    openOnClick: true      # 点击通知打开/切换 GUI 会话（默认 true）
    directActivate: true   # 优先投递给存活的本机回环 GUI 标签；否则走浏览器深链
    baseUrl: ''            # 自定义 GUI 根地址（默认自动取 webServer 端口）
    approval: true         # 等待用户审批时通知（默认 true）
    approvalWaitMs: 3000   # 审批等待多久后弹通知
    question: true         # 等待用户回复时通知（默认 true）
    questionWaitMs: 3000   # 提问等待多久后弹通知
    suppressWhenVisible: true  # 正查看的会话抑制通知（默认 true）
    visibilityTtlMs: 25000      # 前台状态新鲜度窗口（客户端约每 10 秒心跳）
    title: 'DeepSeek Harness'
    body: '任务已完成'
    bodyError: '任务出错'
    maxPromptChars: 64
```

## 工作原理

1. **身份注册（一次性、自动）。** Windows 只展示来自*已注册身份*的 toast。激活时插件会：
   - 向 `%LOCALAPPDATA%\DeepSeek` 编译一个微型 `DeepSeek.exe` 占位程序；
   - 创建指向它的开始菜单快捷方式 `DeepSeek.lnk`，图标为多尺寸 `DeepSeek.ico`（由官方 DeepSeek Harness favicon 生成）；
   - 通过 `IPropertyStore` P/Invoke 把 `AppUserModelID`（`DSH.WinNotify`）写入快捷方式（BurntToast 技术）。
   此后通知以 **DeepSeek** 名称和鲸鱼图标显示。快捷方式是身份载体 —— 请勿删除；缺失时插件会自动重建。
2. **事件钩子。** 插件在宿主层监听 `agent/status` 事件。当某会话的代理由 `running` → `idle` 时，检查该会话日志最近一次 `turn/end` 的原因：`completed` → 通知，`error` → 错误通知（若启用），`aborted`（手动停止）→ 跳过。
3. **通知。** 以 UTF-16LE `-EncodedCommand` 脚本启动 `powershell.exe`（Windows PowerShell 5.1，带 WinRT 投影），脚本展示带 `ms-winsoundevent` 音频元素的 `ToastNotification`，中文文本不会乱码。若注册失败，回退到 `NotifyIcon` 气泡。
4. **点击打开、不产生临时标签。** 对本机回环 GUI 地址，注册的 `dsh-win-notify://` 协议会启动本地微型 `DeepSeek.exe` 助手而不是浏览器。它请求本机 DSH 服务向最近聚焦的存活 GUI 标签投递 `open-session` 命令；该标签原地调用 `sessions.open(id)`（无整页刷新、不新开浏览器标签）。成功确认后，助手会尽力用 Windows UI Automation 选中标题匹配的 Chrome/Edge 标签，让你在其他标签浏览时点击通知也能把 DSH 标签带到前台。助手按切换后的标题匹配标签，并以应用名标记兜底防竞态；最大化或普通大小的浏览器窗口保持原状，仅最小化的窗口会被恢复。浏览器辅助功能、权限级别、虚拟桌面与焦点抢占策略仍可能阻止前台切换；此时会话也已在后台选中。若没有存活 GUI 及时确认，或协议注册不可用，助手安全回退到常规 `<gui>/?session=<id>` 深链；其 `BroadcastChannel` 交接作为第二重回退。首次自定义协议点击可能需要一次性浏览器/Windows 确认。非回环的自定义 `baseUrl` 出于安全考虑保持常规 HTTP 深链。

## 故障排查

- **没有通知：** 检查 Windows 设置 → 系统 → 通知 → `DSH.WinNotify` 已启用；同时确认开始菜单快捷方式 `DeepSeek.lnk` 存在。
- **诊断日志：** 插件会把每次注册尝试与通知追加记录到 `$DSH_HOME/dsh-win-notify.log`。

## 许可证

MIT。通知图标源自 DeepSeek Harness favicon（`@deepseek-ai/dsh-web-frontend`，MIT © DeepSeek）。
