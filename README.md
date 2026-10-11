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
- 原生 Windows Node.js，或启用了 Windows 可执行文件互操作的 WSL2。
  WSL 中的 `PATH` 必须包含 `powershell.exe`（Windows PowerShell 5.1），
  且 `wslpath` 可用；无需 PowerShell 7（`pwsh`）。
- dsh（DeepSeek Harness）—— 任意 profile（web、headless、tui）

### WSL2

在运行 dsh 的 WSL profile 中使用下方相同命令安装插件。通知、声音、开始菜单
快捷方式和点击助手属于当前 Windows 用户。插件通过 WSL 导入的 Windows `PATH`
查找 Windows PowerShell，并使用 `wslpath -w` 转换图标和较大临时脚本的路径
（包括通过 WSL UNC 暴露的 Linux 路径）。原生 Windows 仍使用 `%SystemRoot%`
和原有 Windows 路径。

点击跳转要求 Windows 助手/浏览器能够访问 WSL GUI。通常 WSL 的 localhost
转发可使 `http://127.0.0.1:<port>` 可达；不可达时检查 WSL 网络和 GUI 绑定地址。
非环回的自定义 `baseUrl` 仍走现有浏览器深链回退，不使用直接激活。
不支持普通 Linux 或 macOS。

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

点击助手支持 Chrome、Edge、Firefox 和 Firefox Nightly。现有 GUI 确认会话切换后，
助手先根据该 GUI 上报的标题匹配 Windows 窗口标题，包括浏览器附加的标题分隔符。
Harness 标签已被选中时，无需辅助功能即可将窗口带到前台。
如果 Harness 隐藏在其他标签后，原有 UI Automation 路径仍需浏览器提供标签辅助功能树。
Firefox 的 `accessibility.force_disabled=1` 会禁用该树；插件不会修改此设置。
Windows 前台限制仍然适用。

- **没有通知：** 检查 Windows 设置 → 系统 → 通知 → `DSH.WinNotify` 已启用；同时确认开始菜单快捷方式 `DeepSeek.lnk` 存在。
- **诊断日志：** 插件会把每次注册尝试与通知追加记录到 `$DSH_HOME/dsh-win-notify.log`。
- **WSL 前置检查：** 执行 `command -v powershell.exe` 和 `wslpath -w /tmp`。
  找不到 Windows PowerShell 时记录 `registration unavailable`；路径转换失败单独记录。
  如果禁用了互操作或 Windows PATH 导入，请启用后在安全时机重新启动 WSL shell/宿主进程。

## 开发与验证

在 Windows 和 WSL 中运行 `npm test`（或
`node --test test/plugin.test.js test/windows-host.test.js`）。无需额外测试依赖。
测试覆盖宿主检测、路径转换与引号转义、脚本暂存与清理、注册重试、气泡回退，
以及完成通知和前台抑制。测试模拟系统操作，不显示通知或修改注册。

Windows 上还可运行 `powershell.exe -NoProfile -NonInteractive -File
test/windows-activation.test.ps1`。该测试编译实际 C# 助手，验证浏览器与标题匹配，
并模拟原生窗口发现和恢复；不操作实际浏览器窗口。

手动验证请使用空闲的测试 profile：确认日志中有 `toast=true scheme=true`，
然后在 GUI 标签页未聚焦时完成顶层任务，检查通知和配置的声音。
切换到另一浏览器标签后点击通知，确认现有 GUI 选中正确会话并来到前台，
且没有新建标签页。同时检查手动中止的回合和正在前台查看的会话保持静默。
Windows 通知设置、浏览器辅助功能和前台限制仍然适用。

## 许可证

MIT。通知图标源自 DeepSeek Harness favicon（`@deepseek-ai/dsh-web-frontend`，MIT © DeepSeek）。
