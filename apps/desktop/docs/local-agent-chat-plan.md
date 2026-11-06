# 本地 Pi Chat：范围、集成与交接方案

> **状态：PR57 已实现本地 Pi v3 路径会话的已保存 Chat 和可编辑本地草稿，尚未合并或发布。**
>
> 本文供后续集成与验收使用。PR57 已完成拆分，冻结 head 为 `2dfd0006f3499a605d2a5e25cdb10004f6e3eeb8`；PR59 布局以及 PR61–63 的 Chat 适配仍待恢复和验证，不能把拆分完成当作集成通过。
>
> 原始研究包含 Pi + Claude Code；当前交付只含本地 Pi。Claude、ID 定位和其它 provider 留待独立后续工作，不是本次 Pi 交付的验收门槛。Chat 可编辑每个 Pane 的内存草稿，但没有发送、Agent 命令、审批或上传通路。
>
> 历史记录：之前的 Grok workflow 已按用户要求停止，当时没有交付实现；停止后工作区无文件改动，仅创建了 feat/local-agent-chat 分支。不得自动恢复该 workflow。后续由接手者按约定的执行方式实施，本文不默认选择 Workflow 或 OMAC，也不授权自行启动新的子任务。

## 1. 目标与范围

### 1.1 用户体验

PR57 为运行本地 Pi 的 Pane 提供标题栏 **Terminal / Chat** 切换：

- Terminal：保留现有终端渲染、键鼠、粘贴和生命周期行为。
- Chat：显示该 Agent 已写入 transcript 的对话，后续内容写入后自动更新。
- 切换只改变客户端展示，不重启、恢复、fork、暂停或结束 Agent。
- 不同 Pane 可以分别显示 Terminal 或 Chat。
- 所有 Agent 操作仍在 Terminal 完成。Chat 底部可编辑本地草稿，不是另一套 Agent Runtime。
- 草稿每 Pane 独立、仅存内存，绑定 Herdr 首次报告的 transcript 路径；换路径、Pane 关闭或观察到 boot 变化后丢弃，隐藏或暂回 Terminal 时保留。
- 空草稿保留一行内容和主题 padding，可增长到六行，清空后收回；Enter 换行，支持普通输入法、文本粘贴和编辑，没有发送动作。

### 1.2 第一版做什么

- 本地 Pi v3、Herdr 报告绝对路径的持久化会话；不定位 ID-only 会话。
- 用户消息、助手回复、基础 Markdown、代码块。
- 工具调用和结果：低调的可展开条目，不用卡片；按 provider 调用 ID 在当前分支配对，一次调用和对应结果共用一项，不按名称合并，也不把缺结果标成运行中。标题、摘要和展开正文沿用正常对话字号。
- 最新落盘分支最多显示最近 200 项，注明更早项数；支持增量更新、向上阅读和回到底部，不包含加载全部历史的入口。
- 文本选择与复制，必要的加载、空态、错误和超限提示。
- 按已观察到的 Herdr 来源变化取消旧读取，以 Pane generation 隔离迟到结果；这不等于 API 回答已绑定 backend boot，限制见第 8 节。
- 用户消息保留背景区分，不再显示冗余的 You 角色标签。

### 1.3 不做什么

- 发送草稿、Agent 命令、审批、向 Agent 回答问题、停止 Agent、工具执行或上传。
- 新 Agent Runtime、Claude / Pi SDK 或 ACP 执行通路。
- Claude Code、Codex 等其它 Agent、Pi ID-only 定位、SSH 读取远端 transcript。
- 独立聊天窗口、跨 Pane 复制同一个聊天视图、历史搜索。
- 会话绑定数据库、transcript 索引库、跨重启保存阅读位置。
- 图片下载或解码、附件自动读取、富工具 renderer、子 Agent 树。
- 逐 token 展示保证，以及与 TUI 未落盘状态的完整镜像。
- 自研 Markdown 引擎、通用 watcher 框架或 Chat 专用 MyGo vendor / 补丁改动；已批准的窄依赖例外见第 2 节。

隐藏 system prompt、签名 / 凭据字段、display=false 的扩展消息不进入聊天正文。Thinking 默认不展示。图片显示占位说明。本功能不新增上传、模型请求或外部分析。

## 2. 核心决策

1. **Herdr 继续持有 PTY 和 Agent。** reherdr 只增加读模型和展示。
2. **来源关联由 Herdr 报告。** 通过 API socket 查询 Pane 当前的 agent_session，不另外维护 Pane → 会话绑定表；报告的路径不构成独立身份验证。
3. **内容来自 Agent transcript，不来自终端网格或 scrollback。** 运行状态沿用 Herdr，不能用文件是否增长推断完成。
4. **第一版是“已落盘对话视图”。** 不承诺 Agent 未落盘 token、Agent 内部草稿或内存分支位置实时可见；客户端本地草稿不属于 Agent 会话。
5. **对 Agent 只读必须在输入路由层成立。** 本地草稿可编辑，但其输入不能进入隐藏 PTY；视觉覆盖终端不够。
6. **复用 MyGo 现有 Markdown / 滚动控件。** 当前展示有界 200 项，不引入 WebView、全历史列表框架或 Orca 的整个架构。
7. **使用精确文件监听和有界核对。** 已批准 `fsnotify v1.10.1` / `golang.org/x/sys v0.48.0` 的窄例外：每个活动 transcript 只监听该文件，1 s stat 核对，5 s 重查 API 来源。不新增通用事件总线或插件体系；文件无变化时不重解析历史。

## 3. 研究基线与现有代码

历史研究基线：**d766f5b69b79defe4e2ced27f7d7bb77a2a70ca3**。本次范围核对冻结 main 为 `2ec737670a697d73330385f82111d42c49a435e1`，PR57 为上述拆分 head；不是对后续移动分支的验证。接手时先检查实际 HEAD、工作区与其它 writer，不能覆盖他人修改。

- 项目是 Go / MyGo 原生客户端，不是 Web 应用。
- 历史研究及本次冻结 main / PR57 基线：Go 1.27.2、MyGo v0.6.0；本地 replace 指向受补丁管理的 third_party/mygo。MyGo v0.7.0 属于待合并的 PR58，尚不能称为 main 已采用或 Chat 已通过资格验证。
- README 约定 Herdr 0.9.5、client endpoint generation 1；本机二进制版本检查也是 0.9.5。
- **尚未验证运行中的 Herdr 对本功能的 agent.get 响应。** 源码存在字段，不代表每个现场会话已经上报了字段。

| 位置                                      | 关注点                                                                    |
| ----------------------------------------- | ------------------------------------------------------------------------- |
| internal/herdr/api.go                     | JSON API socket 路径、命令环境                                            |
| internal/herdr/shell.go                   | client socket、snapshot、ShellAgent、UI 请求                              |
| internal/app/e2e_api_test.go              | 历史研究的独立 JSON API 示例；PR57 的生产查询已在 internal/herdr/agent.go |
| internal/app/chat.go、internal/transcript | PR57 的 Pane 生命周期 / 草稿 / 展示及 Pi parser / reader / Follow         |
| internal/app/pane_card.go                 | Pane 标题栏尺寸、按钮布局、命中区域                                       |
| internal/app/view.go                      | paneContainer、paneHeaders、paintGrid、全局快捷键                         |
| internal/app/model.go                     | App 状态、互斥锁、刷新与调用                                              |
| internal/app/machine.go                   | 本地 / 远程身份、连接 epoch、断线与取消                                   |
| internal/app/painted.go                   | 已绘制帧、最新目标、输入 effect 有效性                                    |
| internal/app/input.go                     | 键鼠、滚动、粘贴、终端输入 effect                                         |
| internal/app/navigation_input.go          | 导航期间暂存输入及 flush                                                  |
| internal/app/terminal_input_owner.go      | 终端输入 owner 身份                                                       |
| third_party/mygo/ui/markdown/view.go      | 已有 Markdown、选择复制、链接与图片选项                                   |
| third_party/mygo/ui/list*.go              | 列表 / 按需构建能力，需确认可变高度消息的适配方式                         |

### 3.1 Herdr 已确认的源码事实

证据版本：**2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01**，不是对其它版本的保证。

- [AgentInfo / AgentSessionInfo](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/api/schema/agents.rs)：agent_session 可选，含 source、agent、kind、value。
- [terminal_agent_session_info](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/app/creation.rs)：身份可来自当前 hook 或持久化恢复信息；不能仅凭引用存在认定 Agent 仍在运行。
- [session_ref_from_report](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/agent_resume.rs)：**Pi 优先保存路径；Claude 保存 ID，即便 hook 同时上报了 transcript 路径。**
- [Pi integration](https://github.com/herdrdev/herdr/blob/2ecf19a92fc3a7fff75b6ce3655ef04f4625ec01/src/integration/assets/pi/herdr-agent-state.ts)：从 SessionManager 取得文件路径并上报。

所以，“关联可以直接查”成立；“Pi 与 Claude 都能直接从 socket 取得文件路径”不成立。

## 4. 数据流与 Module 划分

```text
现有 Herdr client socket ── snapshot / Agent 状态 ──→ reherdr
                                                     │
                                      本地 Pane 进入 Chat
                                                     │
Herdr JSON API socket ←─ agent.get(target = paneID) ──┤
                     ── agent_session / AgentInfo ──→ │
                                                     ↓
                               使用 Herdr 报告的 Pi 文件路径
                                                     ↓
                               增量 JSONL + provider 解析
                                                     ↓
                                 不可变展示快照 / 读取状态
                                                     ↓
                              Pane 内 Chat + Markdown + 本地草稿

Terminal 输入 ── 现有 Herdr 通路 ──→ 原 PTY / 原 Agent
Chat 没有 Agent 输入通路
```

只保留三个小 Module：

1. **Herdr 会话查询 Module**：internal/herdr 中的小 Interface，接收 context、API socket、显式 Pane ID，返回必要的 Agent / 会话字段。
2. **Transcript Module**：PR57 使用 internal/transcript，隐藏文件 offset、Pi v3 格式、树投影和工具配对；输出稳定 ID 的展示项与读取状态。Claude 定位和格式不在当前实现中。
3. **Pane Chat Module**：internal/app，负责模式、后台生命周期、状态展示、滚动和输入隔离。

Interface 不要求固定 Go 命名，但必须满足：

- socket / 文件 I/O 不在 render 或持有 App.mu 时执行。
- UI 不接触原始 provider JSON、文件游标或父链索引。
- 展示项有稳定 ID、角色 / 类型、正文或工具信息；缺失时间允许留空，不伪造。
- 工具项保留 call ID、名称、参数、结果及错误标记；缺结果不等于正在运行。
- Reader 发布不可变快照；UI 不与后台共享可变 map / slice。
- waiting、empty、error、unsupported、limited 等原因可区分。

## 5. Herdr 查询与文件定位

### 5.1 查询正确的 socket

- snapshot 来自 herdr-client.sock，现有 ShellAgent 没有 agent_session。
- 使用**同一 Herdr session** 的 JSON API socket herdr.sock，沿用 SocketPath(session) 规则。
- 不假定 client endpoint 的 Shell.Call 可以调用 agent.get；该 endpoint 仅开放部分 UI 方法。
- 显式指定 Pane ID，不使用“当前焦点 Pane”的隐式目标。

请求示例，执行者须与实际安装版本核对：

```json
{ "id": "chat:42", "method": "agent.get", "params": { "target": "w1:p2" } }
```

PR57 的 GetAgent 读取 result.agent 的 pane_id、agent、agent_session；不以 terminal_id、cwd 或 revision 证明会话身份。agent_session 示例：

```json
{ "source": "herdr:pi", "agent": "pi", "kind": "path", "value": "/absolute/session.jsonl" }
```

PR57 每请求独立连接，context 取消时关闭连接，超时 1 s、响应上限 1 MiB；校验响应 ID、agent_info 类型、目标 Pane 和字段类型，区分 Herdr error 与缺失 metadata。

不要要求 AgentInfo.revision 与 UI snapshot revision 完全相等；无关状态变化也会推进 revision，会造成读取一直被丢弃。防串身份见第 8 节。

### 5.2 Pi

- 只接受 Herdr 报告的 Pi kind=path、clean 绝对路径，长度最多 4096；支持 --session-dir 自定义位置，不限制在默认 sessions 根目录。
- 路径只代表 Herdr 报告的来源，不是独立验证的 session / boot 身份，也不是 sessions-root 沙箱。
- Reader 非阻塞打开后检查普通文件，并检查 Pi v3 header；拒绝 FIFO、socket、目录。watcher 的 stat/Add 竞态另见第 7 节。
- 尚未上报、--no-session 或只有 ID 时，不猜最近的文件。
- **首版不为 Pi ID-only 新增全盘扫描 / 索引。** 提示尚未取得文件路径 / 无可读持久化记录。若现场官方 integration 只给 ID，先核对版本与能力，不自行扩大方案。

### 5.3 Claude Code（后续独立研究，未实现）

以下保留原始定位研究，不是 PR57 已实现能力或 Pi 验收条件。Herdr 通常返回 ID，后续实现需要：

1. 只在已知配置根目录内定位：默认 ~/.claude，以及应用实际获知的显式 CLAUDE_CONFIG_DIR。
2. 在相应 projects 下查找精确 session ID 对应的文件名；cwd 可用于缩小范围，但不能是唯一正确性依据。
3. 校验 ID，禁止目录分隔符 / 路径跳转，不能直接把不可信 ID 当路径。
4. 核对候选记录中的 sessionId 等身份字段，拒绝明确不匹配的文件。
5. 唯一候选才使用；找不到则等待 / 报错；多个不同文件符合则报告歧义，不按 mtime 选一个。
6. 扫描有数量 / 时间上限，在后台执行。缓存成功结果；未命中退避，不每 500 ms 扫整个 projects。

GUI 环境不一定等于 Agent shell 环境。后续 Claude 实现若不知道账号 / 配置根目录，应明确报告无法定位；不抓取进程环境、不扫描整个 home、不新增账号管理。当前 PR57 只报告 provider 不支持。

## 6. Transcript 解析与历史语义

### 6.1 通用规则

- record 不等于气泡；正文、工具调用、结果需要转换。
- 选择可证明的持久化分支，不把所有分支按时间拼接。
- **展示历史，不重建发送给模型的 context。** 压缩 context 不等于删除历史。
- 不按纯文本内容去重：两个相同的真实用户消息必须都保留。
- 未识别 metadata 可跳过；未知消息 / 内容块用有限占位说明，不展示整块原始 JSON。
- 工具结果不得画成用户发言；配对只能发生在当前会话 / 分支。
- 不跟随 transcript 内的附件路径自动读文件，不执行内容中的指令或工具。

### 6.2 Pi

PR57 只解析 Pi v3；其它版本明确提示不支持，不写回迁移。公开 Session Format / Message Types 是研究参考，不代替实际兼容版本与 fixture。

| 内容                                                             | 展示 / 处理                                                                |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| session header                                                   | 检查 type=session 和 version=3，不独立验证 header 的 session ID / 路径归属 |
| user                                                             | 字符串或内容数组中的文本                                                   |
| assistant                                                        | text；toolCall 转可展开条目；thinking 不展示                               |
| toolResult                                                       | 按 toolCallId 配对，保留 isError                                           |
| bashExecution                                                    | 独立折叠活动，不冒充 LLM 工具结果                                          |
| compaction / branch_summary                                      | 显示压缩 / 分支标记，不据此删除原始历史；不声称有摘要展开 renderer         |
| custom_message / custom role                                     | 仅展示明确 display=true 的文本；不运行扩展 renderer                        |
| system / usage / model / thinking / label / 普通 custom metadata | 不当聊天正文；树索引仍需保留可连接的 entry                                 |
| context_edit                                                     | 改变模型 context，不改变原始历史；不覆盖 / 删除原聊天消息                  |

建立 id → parentId 索引，从最后落盘的有效树 entry 回溯并逆序；检测循环、冲突 ID、断链。**不能先过滤出 message 再建树**，非消息 entry 也参与父链。

重要限制：Pi 的 /tree 可以只改变 SessionManager 的内存 leaf 而不写文件；Herdr 引用又不含 leaf ID。因此首版显示“最新落盘分支”，不能保证就是 TUI 当前停留的位置。下一次该分支追加记录后更新。Chat 应以“已落盘记录”说明该语义。parentSession 仅作来源信息，不自动追读其它文件。

### 6.3 Claude Code（后续独立研究，未实现）

以下是后续 parser 的研究要求，不是 PR57 的测试结果。格式兼容性须以实际 CLI 版本及 fixture 为准，不假设存在永久稳定的全格式契约。

后续工作必须覆盖：

- user / assistant，message.content 的字符串或数组。
- text、tool_use、tool_result；工具结果可能位于 user 记录，不能误作用户气泡。
- uuid、parentUuid、sessionId；message.id 可能由多个 record 共享，不能直接当全局唯一 record ID。
- 同 ID 的已知更新 / 重复记录合并或替换；不同 ID 的真实记录不得按内容去重。
- sidechain / 子 Agent 记录不混入主对话；首版不读 subagents 目录。
- compaction / summary / interrupted 等已知标记；隐藏合成 user 不冒充人工输入，其中真实工具结果仍应保留。

通过 fixture 确认主对话链和 compaction 后父链重置语义；不能证明连接时显示缺口 / 不支持，不猜测连接另一分支。支持的格式版本与 fixture 一起交付。

## 7. 增量读取、性能与上限

### 7.1 读取策略

- 每个活动 transcript 使用精确文件 fsnotify watch，不监听目录；1 s stat 核对遗漏事件 / 缺失文件 / watch 替换，5 s 重查 API 来源；单次 socket 超时 1 s，不新增设置页。
- 当前 tab 内每个可见本地 Chat 独立订阅，无论键盘焦点在哪；隐藏 tab、zoom 隐藏或 Terminal/TUI Pane 不创建 Chat 查询、watch、stat timer、reader 或 parser。
- Reader 保留文件身份、offset、末尾未完成字节、Pi entry 索引和不可变展示快照。
- 无变化时只做必要 metadata / stat，不重读和重解析历史。
- append 从 offset 继续，仅提交换行完整 record。半行及跨批次 UTF-8 留到下一轮。
- 文件身份变化、文件缩短、同尺寸但 mtime 变化时重建；比较已消费部分首尾各 256 字节。更长重写若保留这两个边界，可能被当成 append；这不是全历史哈希。
- 文件暂时消失 / 权限问题明确展示并可重试，不能把旧会话冒充新结果。
- 完整行损坏 JSON、重复 ID 或缺失父链停止展示，直到文件重写；不会像 Pi 那样跳过坏行或把孤儿当根。错误不包含原文，也不静默宣称历史完整。
- 普通 append 不重解析旧 record，但每次变化仍会回溯有界父链，复杂度 O(entries)；不能据此宣称已做全历史虚拟列表或真实多 Pane 性能验收。
- watcher 在 Add 前 stat 确认普通文件，避免 kqueue 打开 FIFO / 遍历目录；stat 与 Add 不原子，期间被换成 FIFO 的竞态仍未覆盖。Reader 自身的 open 非阻塞。

**轮询不是 token streaming。** Pi 通常不把 pending assistant 保存到 JSONL，回复可能结束后才有正文出现。

### 7.2 PR57 的资源上限

以下是冻结 PR57 的内部上限，不是已完成 native / 大规模性能验收的承诺；调整须附边界测试和原因：

| 项目              | 上限 / 超限行为                                           |
| ----------------- | --------------------------------------------------------- |
| socket 响应       | 1 MiB，达到上限停止读取                                   |
| transcript 文件   | 64 MiB，超限明确提示，不静默截取尾巴                      |
| 单条 JSONL record | 8 MiB，不能依赖默认 Scanner 的小 buffer                   |
| 单会话 entry 数   | 50,000，超限停止并说明                                    |
| 单展示文本块      | 128 KiB，截断必须有标记，展开也不绕过上限                 |
| 后台读取批量      | 1 MiB，批间检查取消，首次加载不占 UI 线程                 |
| 展示项            | 当前落盘分支最近 200 项；注明更早项数，没有加载更早项入口 |
| 同一个 owner      | 查询 / reader 不重入，不累积未完成轮询任务                |

折叠工具项显示摘要，展开构建有界正文。调用与结果先按 ID 配对，再取最近 200 项；更早项数明确显示。PR57 使用有界视图，没有实现全历史加载、分页协议、磁盘索引或虚拟列表。

## 8. 后台生命周期与防串会话

### 8.1 工作身份

PR57 以本地 machine、当前 snapshot boot、Pane、Chat subscription generation 和已观察到的 Pi 来源路径管理订阅。切换 / 隐藏时取消各自的工作，返回可见时重查来源并追上文件；不会因为键盘移到旁边 Terminal 而停止其它可见 Chat。

`agent.get` 的回答没有绑定生成可见 snapshot 的 backend boot。Herdr 0.9.5 的此 API 不提供 boot / instance 身份；Pane generation、clean 路径和来源复查不能补足它。只有观察到新 boot 的 client snapshot 后，syncChats 才清理所有 Chat / 草稿。`TestAgentGetIsNotBootBound` 用 fake API 展示同 Pane ID 的另一 boot 来源在该 snapshot 到达前被显示；它没有证明真实重启时两条通路的先后或持续时间。更强保证需要 Herdr 变更和 owner 决策，本次不声称已修复。

### 8.2 生命周期

- 进入 Chat：立即加载态，后台查询，不阻塞点击。
- 同 Pane 改会话 / provider、/new、/resume：重新核对引用，取消旧读，清理旧正文 / 滚动 / 工具展开。
- 离开 Chat、隐藏 tab、切机器、Pane 关闭、断线、boot 变化、窗口退出：取消相关工作。恢复可见后先确认身份。
- 迟到结果先检查 owner / generation，再发布不可变快照；取消后不能再更新 UI。
- 来源每 5 s 重查；观察到变化后先取消旧 Follow 的发布许可，再等旧读取退出。首次读取与 API 回答不是原子快照，不保证读取完成后同步复查。
- 新来源被观察到后旧结果不能覆盖；尚未观察到的变化不承诺零延迟，boot 限制见上文。
- 连接不确定则显示断线 / 非实时，不把数据绑定到另一个活 Pane。

模式是窗口本地状态，启动默认 Terminal，不持久化。不同 Pane 独立。已在 Chat 的 Pane 如果 Agent 退出 / 不再支持，留在只读空态，**不能自动弹回可输入 shell**。

### 8.3 远程禁止访问

在任何本地 API / 文件访问之前确认 machine 为本地。远程 Pane 不开放新的 Chat；已有展示状态遇到远程目标，显示不支持且可返回 Terminal。不得把远程绝对路径在本机打开。

## 9. UI、滚动与输入隔离

### 9.1 标题栏 / 正文

- 本地 Pi Pane 提供 Terminal / Chat 切换；已进入 Chat 的 Pane 即使 Agent 不再支持，也保留回 Terminal 的入口。沿用主题、控件、accessibility label。
- 不与 close / zoom / split / 标题命中区重叠；窄 Pane 优先保留退出 Chat 的入口，必要时缩减次要控件。
- 只替换该 Pane 内容，不改变其它 Pane，也不停止底层 PTY / Herdr 的尺寸管理。
- Markdown 使用 MyGo ui/markdown，默认不提供 LoadImage 或 HTML 执行能力。
- 链接仅在用户点击后打开允许的 http / https 地址；不隐式读取本地路径 / 执行自定义 URI。
- 工具条目按调用 ID 配对，默认折叠、可展开，不做卡片 / 引用边线 / inline-code chip；未匹配记录独立显示，审批或问题不提供交互控制。
- 用户消息有背景而无 You 标签；草稿保留主题边框和 Step12 padding，一行内容起步、最多六行、清空收回。明确提示 sending unavailable，不能把总高度压成一行文字。
- 底部阅读自动跟随；向上阅读不抢滚动，提供“回到底部”。
- 复制只来自 Chat 选区；无选区也不得回退为向 Agent 发送 Ctrl-C。

### 9.2 必须审计所有输入入口

不能只把 Chat 覆盖在 grid 上。需要检查：

1. gridInputFor 等文本、按键、IME、paste 通路。
2. navigation_input.go 的输入暂存及最终 flush。
3. shown / showsTarget / live 和最终发送 effect 的许可。
4. 鼠标、拖选、滚轮、右键菜单、文件拖入、剪贴板路径粘贴。
5. 全局终端内容动作，例如清屏 / 粘贴 / 编辑 scrollback；Chat 不能隐式操作隐藏终端。
6. native terminal input owner / preedit；PTY 没变不代表切换前后输入 owner 相同。

Chat 中普通键盘、Enter、Ctrl-C、paste、IME 提交、滚轮都不得变成该 Pane 的终端输入。草稿取得真实本地键盘焦点，不向 Herdr focus Pane；因此草稿聚焦时，作用于 Herdr focused Pane 的关闭、分屏、清屏、缩放和方向快捷键被阻止，Tab / Shift-Tab 留在字段。点击 Terminal 或显式切回 Terminal 后才交还输入。

切模式清除相关终端 preedit，并阻止尚未接受的输入及 retained navigation 向 Chat 发送；切换前已进入传输 FIFO 的终端输入无法撤回。对已发出 key-down 的旧输入流，用现有 stream 收尾机制处理必要 release，避免卡键；不把旧流 release / composition 交给新目标，也不靠“所有 key-up 丢掉”破坏协议。

继续遵守已绘制帧命中规则。切换 click、重绘前后、popup / native dialog、跨 Pane 快速导航均要测试；Chat 不能阻断其它 Terminal Pane。

## 10. 状态与错误语义

| 状态                          | 行为                                                  |
| ----------------------------- | ----------------------------------------------------- |
| Loading                       | 查询 / 首次加载，不展示另一会话旧正文                 |
| WaitingForSession             | Agent 已识别但尚未上报所需引用 / 路径                 |
| WaitingForFile                | 身份已知文件尚未出现，有界重试                        |
| Empty                         | 文件有效，无可展示消息                                |
| Ready                         | 当前引用的已落盘记录 + Herdr 运行状态                 |
| Unsupported                   | provider / 版本 / 远程不支持，说明原因，可回 Terminal |
| Ambiguous（后续 Claude 研究） | 多个匹配文件时拒绝猜测；当前 Pi 不扫描候选            |
| Error                         | socket / 权限 / 格式错误，可重试                      |
| Limited                       | 达到上限或文本截断，说明不是完整历史                  |
| Disconnected                  | 连接不确定，不宣称实时                                |

此表描述状态语义，不表示 PR57 有同名 enum 或已实现 Claude 定位状态。当前 Pi 用可读原因区分来源 / 文件 / parser 问题；错误不带用户原文或完整工具输出。

## 11. 测试与验收

以下是验收清单，不是本次文档修订运行过的测试。PR57 的现有证据来自合成 fixture、临时目录 / socket 和 headless ui.NewTester；不能充当 native 或 live Herdr 验收。不得读取、提交或打印真实用户会话。

### 11.1 Herdr 与定位

- 正常查询、path / id、缺失 metadata、Agent 退出、Herdr error。
- 响应 ID / Pane 不匹配、错误字段、超时、取消、超长响应。
- Pi 自定义 path、ID-only 明确降级，不猜最近文件。
- 后续 Claude 独立工作才需要精确命中、cwd 变化、多根目录、歧义、sessionId / ID 校验与文件缺失 fixture；不计入当前 Pi 门槛。
- 远程在任何本地访问之前被拒绝。

### 11.2 Parser 与增量

- Pi v3：字符串 / 数组、toolCall / toolResult、bashExecution、display custom、摘要、context_edit。
- Pi 分支 A→B→C / A→D→E 只选择落盘 leaf 路径；metadata 参与树连接。
- 多 root、循环、断链、冲突 ID、未知 record、旧版本明确不支持且不写文件。
- 后续 Claude 独立工作才验证正文 / 工具、同 response 多 record、更新 / 重复、sidechain、压缩 / 中断。
- 相同文本的真实消息不被去重，工具结果不跨分支配对。
- 半行 / UTF-8 跨批次、无换行末尾、损坏完整行、截断、同尺寸重写、rename 替换。
- 无变化不重读 / 重解析，append 不重复消息，取消停止读取。
- 文件 / record / entry / 文本上限，超大图片载荷不无限占内存。

### 11.3 App 与 UI

- Pane 独立切换，不停止 / 重启原 Agent；旁边 Terminal 正常输入。
- Chat 中按键、IME、paste、Ctrl-C、滚轮、拖文件、导航 flush 无 PTY 输入。
- Terminal 原输入 / 导航回归通过，跨模式已按下键正确收尾。
- 选择复制、滚动、工具展开、回到底部只操作 Chat。
- 多可见 Chat 同时更新；隐藏 / 断线取消；重新显示确认身份。
- 已观察到的 session / provider、关闭、boot / machine / 模式变化撤销旧发布；保留测试说明 API 不绑定 boot 的已知缺口，不把此项标成完整重启身份保证。
- 退出 Agent 不自动进入可输入 shell；错误 / 远程 / 不支持态都可回 Terminal。
- 窄 Pane、主题、resize、split、zoom、popup 下展示和命中正确。
- 不自动请求图片 / 读附件 / 执行内容；长历史不拖慢其它终端。

优先使用现有 ui.NewTester / App fixture，不新增测试框架。

### 11.4 最终通过条件

- [ ] Pi v3 path 会话有可重复 fixture、支持范围和兼容版本说明；Claude / ID 定位不计入本次交付。
- [ ] 来源来自 Herdr，无绑定数据库 / 新 Runtime；披露报告路径与 boot 绑定的限制。
- [ ] Pane Terminal / Chat 切换、历史与更新可用。
- [ ] 输入隔离、迟到结果隔离、远程禁止访问有自动化测试。
- [ ] 状态来自 Herdr，文件静止不被误判为完成。
- [ ] 已落盘 / Pi 内存分支限制有可见说明，不宣称 token 实时镜像。
- [ ] make check、make build 通过，无并行的独立 Make invocation。
- [ ] 依赖仅含已批准的 fsnotify v1.10.1 / x/sys v0.48.0 例外；Chat 不新增 vendor / toolkit patch 改动，不含真实对话或 secrets。
- [ ] 恢复第 12 节跨功能断言，在固定的最终集成 SHA 验证；MyGo 0.7 未集成前不声称已资格验证。
- [ ] 完成源码 review，GUI 验收有结果或明确标记未验。

## 12. 实施顺序、职责与操作边界

PR57 的查询、Pi parser / reader、展示和本地草稿已实现；本节保留交接分工，当前任务是集成与资格验证，不是重新实现或恢复旧 workflow。

### P0：先确认能力

检查工作区 / 固定版本，阅读现有输入安全机制；只有获得授权后，才在隔离环境以显式 Pane 验证 Pi agent.get 路径和兼容格式。Claude CLI / 定位留给独立后续工作。使用公开源码和合成 fixture，不取用户真实内容。

若安装版本不报告 Pi 路径，记录该能力缺失，不通过进程扫描、新启动器或自动安装 hooks 绕过；不得因此把路径上报称为 boot 身份证明。

操作 Herdr 前加载 Herdr skill、验证 HERDR_ENV=1、读当前 CLI help。不得拿用户正在工作的 Pane 做试验，不关闭 / 重启用户 server。

### P1：数据 Module

所有权：internal/herdr 的窄查询 helper、internal/transcript、测试 / fixture。

PR57 已包含：可取消查询、Herdr 报告的 Pi 路径、Pi v3 parser、有界增量 reader、稳定展示模型。集成时保留 Interface、支持范围、错误语义、上限和测试证据；不添加第二个 parser 或 ID locator。

### P2：Pane Chat Module

所有权：必要的 internal/app 改动和测试，消费 P1 Interface，不在 UI 再解析 provider JSON。

PR57 已包含：模式切换、独立可见订阅、Markdown / 工具 disclosure / 状态、本地草稿和输入隔离。集成时继续证明 Chat 不写 PTY，保留真实键盘 / composition owner。

### P3：集成与交付

数据 / UI 交付明确后，由集成 owner 做最小接口修正、回归、review、文档和 PR。多个执行者应明确文件所有权，使用隔离 worktree 或串行交接；不能同时写共享 checkout，也不必为了小功能创建 writer swarm。

PR57 已在 `2dfd0006f3499a605d2a5e25cdb10004f6e3eeb8` 完成 Chat-only 拆分；原始来源为 `a6c2dc4ce5941853c255213b6fe0ff64ea214ecc`。后续只对已审阅并固定的 main 做普通集成，不重放拆分、不整树覆盖、不导入未审阅 MyGo 依赖。

当前必须恢复的适配与证据：

- **PR59 布局**：保留 Compact / Comfortable 几何、frameLaid / shellMetrics、样式动画和测试。对 main `2ec7376` 与冻结 PR57 的只读三方合并检查发现：尾部 syncChats 会自动落入 viewCompact，而不是所有 View 分支。文本无冲突不等于正确；需把订阅同步放在各分支布局后、App.mu 解锁前的共同出口，验证两种布局及 sidebar 开关。此处是源码合并风险分析，不是已执行的集成测试结果。
- **PR60 窗口状态**：保留独立窗口状态功能，草稿 / Chat 模式仍不写磁盘；测试使用临时 config / state 目录。
- **PR61 提示**：恢复原 TestPausedTerminalLeavesTheDraft 的持续 paused 提示、草稿可编辑、无 unsent 警告和零 PTY 输入断言；复用通用 notes helper。
- **PR62 tint**：keyboardPane 先按 draft.field.Focused(c) 找真实草稿 owner，再查 navigation / surface；chatViews 在 inactiveScrims 之前，header 在其后。恢复 veiled / accented / fillTerminal、TestInactivePanesAreVeiled、TestInactiveVeilTints、TestOnePaneShownIsNotVeiled、TestVeilPreview，以及工具 / 草稿视觉测试原有 f.focus("a") 设置。保留通用测试，不弱化色彩 / 对比断言。
- **PR63 拖动**：在安全的通用拖动实现上恢复 TestTabDragPreservesChatDraftFocusAndComposition，保留 KeepFocus、草稿内容和焦点、returnFocus=false、无额外 PTY / 命令。原 Terminal composition 段只是日志，不能代替独立 PR63 的硬断言；不恢复旧不安全拖动实现。
- **PR58 / MyGo 0.7**：等待独立审阅与 main 集成后，记录实际固定 SHA / patch 身份，再验证 TextArea、IME、焦点、disclosure 和终端输入隔离；0.6 或拆分前结果不能替代。

[冻结 PR57 的集成义务](https://github.com/iamdin/reherdr/blob/2dfd0006f3499a605d2a5e25cdb10004f6e3eeb8/docs/chat-integration.md) 与[实际范围 / 限制](https://github.com/iamdin/reherdr/blob/2dfd0006f3499a605d2a5e25cdb10004f6e3eeb8/docs/chat.md) 是交接证据。原测试保存在项目 scratch 的 384c9739-original-*；它们与原始 Git blob 一致，但不是最终集成的通过证据。跨功能适配及其验证仍阻塞 Chat review-ready，Claude 不阻塞。

### 验证命令

遵守 README 的准备规则，以下命令串行执行：

```sh
make check
make build
```

单独调试 Go 测试须先完成 MyGo 准备；race 检查优先针对纯 Go 数据 Module，不假设完整 GUI / native 依赖在任意平台都支持。

make e2e、SSH integration、真实窗口 / daemon 测试有外部效果，仅在授权且隔离 session 下执行，不与其它原生 / integration 检查并行。不得向用户工作 Pane 发测试 prompt / 按键。

PR 至少记录：范围、支持版本、自动化结果、截图或 GUI 未验说明、落盘 / 分支 / 定位 / 超限限制。只提交功能代码、测试与必要文档。

## 13. 已知限制与停止条件

当前限制不自动扩大范围：仅本地 Pi v3 path；ID-only、Claude 和其它 provider 未实现。Pi 纯内存 /tree 无法观察；持久化频率决定更新粒度；最多最近 200 项；无实时子 Agent / 图片 / 富工具 renderer；parser、watch 与重写检测限制见第 6–7 节。

boot 绑定缺口见第 8 节，不得以 generation 或路径校验宣称已解决。live Herdr 0.9.5 是否为现场 Pi Pane 提供路径仍未验证；AppKit 真实模式切换的 marked text、拖放和菜单 Copy 仍未 native 验收。现有 TestToggleElsewhereKeepsTheComposition 直接调用 toggleChat，不等于真实 header 点击。真实多 Pane 资源 / 延迟没有硬件验收结果。

这些是必须披露的边界，不是新框架或新 provider 的实施授权。任何已复现的错目标输入、composition 泄漏或普通拖动失败仍须修复，不能用“已知限制”或日志代替安全断言。

遇到以下情况停止并向 owner 报告：

- 需要比当前 Herdr 报告来源更强的 boot / session 证明：向 owner 报告现有缺口，不擅自修改协议或扩大保证。
- 后续 Claude 独立任务无法通过 fixture / 源码证明主链 / compaction 语义；这不要求当前 Pi 实现 Claude。
- Chat 集成需要修改 Herdr、MyGo vendor / 补丁、Runtime 或引入已批准窄例外以外的依赖。
- 需要真实会话正文、进程环境、上传或新 hook 安装来发现路径。
- 触及文件存在他人未提交修改 / 活跃 writer。

## 14. 可直接使用的 handoff

> 在固定的已审阅 main 上集成现有 PR57：本地 Pi v3 path 的已保存 Chat，加上每 Pane / 路径绑定的可编辑内存草稿。PR57 已实现且已拆分，尚未合并或发布；不要重做拆分或添加 Claude / ID locator。
>
> 保留 Terminal / Chat 切换及原 PTY / Agent；草稿一行内容加 padding 起步、最多六行，支持 IME / 文本粘贴但不发送、执行命令、审批或上传。保持无 You 标签和按调用 ID 配对的低调 disclosure。
>
> 用同一 Herdr session 的 JSON API socket 查询显式 Pane；只读 Herdr 报告的 Pi 路径，不建绑定表或猜文件，不声称 boot-bound 或 sessions-root 沙箱。每个当前 tab 可见 Chat 独立监听精确文件，隐藏 / Terminal 不做 Chat 工作。保留已批准 fsnotify / x/sys 例外和现有 toolkit 补丁管理。
>
> 按第 12 节恢复 PR59 / PR61–63 适配及原断言，修正所有 View 分支的 syncChats 同步，再在最终固定的 MyGo 基线上执行 make check / make build 和独立 review；PR58 未合并前不声称 0.7 合格。保留输入 / composition 的真实 owner 和最后发送门禁，不让导航缓存补发给 Chat。
>
> 本文的修订不是集成测试结果。记录实际 SHA、依赖版本、自动化输出、native / live 未验项及 boot / parser / watch / 重写限制。真实窗口 / backend 操作另需授权；不得恢复已停止的 workflow 或自行扩大范围。

## 参考

- [项目 README](../README.md)
- [现有导航与输入约定](navigation-input.md)
- [Pi Session Format](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/session-format.md)
- [Pi Message Types](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/message-types.md)
- [Pi SessionManager](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/session-manager.ts)
- [Orca Chat UI](https://www.onorca.dev/docs/agents/native-chat)
- [Orca Claude decoder（研究版本）](https://github.com/stablyai/orca/blob/22210eb3d10d1948849066a0828c04952266331d/src/main/native-chat/transcript-line-decoders-claude.ts)

外部文档和安装版本会变化，参考不是对其它版本的兼容保证；实现交付必须记录实际验证版本。
