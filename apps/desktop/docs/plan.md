# vibest-desktop 方案

用 [MyGo](https://github.com/egoist/mygo) 做 [herdr](https://herdr.dev) 的原生桌面客户端，实现 [penso/herdr-gpui](https://github.com/penso/herdr-gpui) 的基础能力。非 herdr 官方项目。

锁定版本：herdr 0.9.5（client endpoint generation 1），MyGo v0.5.1。

## 路线：A（herdr-gpui 模式，client-shell 协议）

- **连接**：herdr 的客户端 socket `herdr-client.sock`（命名 session 在 `sessions/<name>/` 下），帧是 u32 小端长度加 bincode 2。握手用 `endpoint.hello.v1`，welcome 的 `generation` 必须是 1，不兼容时显示 herdr 给的错误。
- **herdr 负责**：布局、外框、PTY 尺寸、按键编码（DECCKM、kitty 键盘协议）、鼠标上报、OSC 10/11/4 主题应答、OSC 52。客户端只上报整窗行列、主题、焦点和语义输入（按键、文本、鼠标、粘贴），再把 herdr 画好的整 tab 网格画出来。
- **控制面**：同一条连接上的 `ClientShellEndpointRequest`，方法是 endpoint 公开的那组（`tab.focus`、`pane.split`、`layout.set_split_ratio`、`pane.link.activate` 等），一次只发一个请求。状态来自 herdr 推送的 `shell.snapshot.v1`。
- 第一版用路线 B（JSON API + `terminal session control` + libghostty-vt）。它拿不到终端模式，PTY 尺寸只能由单一 controller 抢占，多个客户端尺寸不同时无法处理，因此改走 A。协议私有、随 herdr 版本变，靠 generation 检查和 e2e 锁版本兜住。

## 范围

做：侧边栏 workspace + agent 状态点、标签页、分屏终端、键鼠和粘贴输入、新建/关闭 workspace/tab/pane、blocked 时系统通知、断线重连、daemon 不在时自动启动。

不做：SSH 多主机、Teleport、浏览器标签页、checkpoint、端口转发。

## 结构

```
cmd/reherdr/main.go             窗口、通知、标题、Dock 弹跳、焦点上报、启动参数（-session / -herdr / -autostart）
internal/app/model.go           App：连接循环、状态、尺寸上报、操作
internal/app/grid.go            网格渲染：按 pane 切成 tile，内容变了才重画；行缓存、字形、选区、光标、框线字符、滚动条
internal/app/input.go           网格交互：键盘、文本、鼠标、滚轮、选区、拖动边框，事件 + Surface 进、effect 出
internal/app/view.go            侧边栏、标签栏、网格、原生右键菜单、状态栏、快捷键
internal/app/state.go           给测试和调试 socket 用的状态快照
internal/app/prompt_darwin.go   macOS 原生确认框和输入框（prompt_other.go 是其他平台的窗口内对话框）
internal/app/debug.go           调试 socket（仅 e2edebug 构建标签 + VIBEST_DESKTOP_DEBUG=1）
internal/chrome/                主题：内置 Paper/Newsprint/Nord、Ghostty 适配、主题选择的保存、图标和尺寸阶梯
internal/sidebar/               workspace 分组和上下移动
internal/ghostty/               读取 Ghostty 配置的主题、字体、光标，以及随包字体
internal/env/                   登录 shell 的 PATH，找 herdr
internal/herdr/wire.go          bincode 编解码、surface 和 patch
internal/herdr/shell.go         client-shell 连接：握手、收消息、Call、输入编码
internal/herdr/api.go           socket 路径和 herdr 子进程的环境
internal/app/e2e_api_test.go    JSON API client，只给 e2e 读 daemon 状态
```

## 数据流

1. 连接、握手（`surface_active: false`），上报窗口行列和单元格像素。界面只记录窗口的行列和主题；每条连接有一个 `sync` goroutine 负责告诉 herdr：先上报主题，再用 `client_shell.surface.set` 激活，之后主题变了就重发，尺寸稳定 150 ms 后上报。激活让本客户端成为 session 的前台客户端，pane 改用它的主题；先激活后上报会让 pane 主题先被清空再设置，深浅色从"无"变过去，herdr 不给 mode 2031 的程序发通知。herdr 只接受已激活客户端的 API 调用，`Shell.Call` 因此等到激活后才发。
2. herdr 推送 snapshot（workspace、tab、pane、agent，以及本客户端自己的焦点位置）和当前 tab 的 surface。surface 的 `projection` 等于 snapshot 的 `revision` 时才显示；patch 必须接在当前 revision 后面，否则等下一个完整 surface。
3. 输入以语义事件发给焦点 pane（有 popup 时发给 popup），由 herdr 按程序模式编码。
4. 操作走 endpoint 请求，结果以新的 snapshot 和 surface 回来，客户端不做本地预测（拖动分隔线除外：本地先移动，只发最新值）。

## 尺寸规则

- 每个 tab 的 PTY 尺寸归一个客户端：最后聚焦这个 tab、在里面输入或调用导航类 API 的那个。
- 其他客户端仍按自己的窗口大小得到布局，PTY 偏大时内容被裁，偏小时留白。
- app 改变窗口大小后去抖 150 ms 上报，再发 `tab.focus` 取回尺寸（单独的 resize 不会取回）。
- 窗口获得焦点时发 `ClientShellFocus`，取回尺寸；herdr TUI 等其他客户端连上或输入时会拿走尺寸，这是 herdr 的规则。

## 阶段 0 结论

| 未知点                      | 结论                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 终端数据通道（路线 B 时期） | `terminal session control`：单 pane 渲染后视口，不带外框；一个 controller 拥有输入和尺寸，`--takeover` 抢占                          |
| 事件结构                    | 生命周期事件无参数；`pane.agent_status_changed` 需 pane_id；`events_lost` 会关闭订阅                                                 |
| `ui.NewTester`              | 能离屏渲染终端插件，L3 可落地                                                                                                        |
| e2e 隔离                    | `HERDR_SESSION=mygo-e2e` + `HERDR_CONFIG_PATH`，并去掉继承来的 `HERDR_SOCKET_PATH` 等 `HERDR_*` 变量（在 herdr pane 里运行时会继承） |
| Finder 启动                 | `$SHELL -l -c 'printf %s "$PATH"'` 取 PATH（5 秒超时，失败用常见目录兜底），`open -n` 实测 501 ms 连上                               |

## 已知限制

- **多客户端尺寸**：同一 tab 只有一个尺寸，见"尺寸规则"。
- **选区只覆盖可见内容**，不能跨滚动历史选择。
- **单次输入上限 1 MB**（herdr 限制）。
- **主题**：一个主题同时决定外壳和 pane 的颜色，见 [themes.md](themes.md)。主题只是客户端的绘制，herdr 仍是唯一后端；settings.json 只存主题选择。没保存过选择时默认浅色 Paper、深色 Nord，跟随系统；Ghostty 的终端颜色要在主题菜单里选 Ghostty。app 读取 `~/.config/ghostty/config` 的 `theme`、`font-family`、`font-size`、`font-feature`、`font-thicken`，主题上报给 herdr；光标形状由 herdr 决定。格子文字默认关掉字体平滑（`font-thicken = true` 时才加粗）。配置的家族都没装上时用随包的 JetBrains Mono 2.304（与 Ghostty 1.3.1 内嵌的是同一版），符号优先用已安装的 Symbols Nerd Font Mono，否则用随包的 Symbols Nerd Font。
- **系统通知**只在打包后的 app 里可用。
- 与 herdr-gpui 相比缺的功能见 [parity.md](parity.md)。

## 注意事项

- **滚动历史在 daemon**：滚轮作为鼠标事件发给 herdr，由它决定滚历史还是上报给程序。
- **焦点**：以 snapshot 里本客户端的焦点为准，点击 pane 只发一次 `pane.focus`。
- **版本检查**：welcome 的 `generation` 不等于 1 或带 `error` 时显示明确错误，不再重试。
- **宽字符**：续接单元格可能是空串，也可能是 patch 留下的空格，宽度一律按字符本身计算。
- **按键优先级**：app 的 Cmd 快捷键（列表见 parity.md）由 app 处理。macOS 行编辑组合键按 herdr-gpui 改写后再发：Cmd-Left/Right 为 Ctrl-A/E，Cmd-Backspace 为 Ctrl-U，Option-Left/Right 为 Alt-B/F；Shift-Enter 在各平台都发成 Alt-Enter。没登记的 Command 组合键留给系统和 app。Ctrl 组合键（含 herdr 前缀 Ctrl-B）原样发给 herdr。字号里 Cmd-+ 与 Cmd-= 相同。
- **只支持 macOS**。

每阶段的验收用例见 [archive/e2e.md](archive/e2e.md)。
