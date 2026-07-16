# 客户端消费形态：改造 Transport 还是新建 Driver

调研产物，服务于 wayfinder ticket「客户端消费形态：Transport 改造还是 Driver」。结论：**保留 `AbstractChat` 作为消息 reducer，把常驻订阅做成 transport 级组件**，不新建绕开 AbstractChat 的 Driver。

## 决定性事实（来自 `ai@7.0.22` 源码）

`AbstractChat.makeRequest`（`dist/index.js` ~16680）：

- 每个 chunk 写入时：`replaceLastMessage = activeResponse.state.message.id === this.lastMessage?.id`。相等 → `replaceMessage`（原地续接），不等 → `pushMessage`（追加新消息）。
- streaming 消息的 id 由流的 `start` chunk 的 `messageId` 决定（`processUIMessageStream`）。
- `resumeStream()` → `makeRequest({trigger:'resume-stream'})` → `transport.reconnectToStream({chatId})`；返回流则按同一套 reducer 消费，返回 `null` 则什么都不做。

**推论**：只要流的 `start.messageId` 稳定且等于历史/临时消息 id，AbstractChat 原生实现了设计稿 §7.4 的 replace-vs-append 归并。三条恢复路径都落到这个机制上：

| 路径                                 | AbstractChat 原生行为                                                                                                                                                      |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 刷新（无 reducer 态）                | mount 时 `messages = getMessages()`，再 `resumeStream()`；replay 流 start.messageId=M。历史已含 M → replace 幂等收敛；未含 → push 追加进行中的 M。                         |
| 断线/slow_consumer（reducer 态还在） | sendMessages 流报错 → status error，但部分消息 M 已在 messages 里。`resumeStream()` 拉 seq>cursor 的续传流，start.messageId=M 命中 lastMessage → replaceMessage 原地续接。 |
| turn.ended                           | `onFinish` 里重拉 `getMessages()` 赋值 messages；同 id M 替换临时投影。                                                                                                    |

这就是 messageId 不变量（ticket 04/05）为什么是全设计最脆一环：它是 AbstractChat 区分"续接"与"追加"的唯一依据。

## 两条路的真实差异

**误区**：以为 Driver 能"绕开 AbstractChat 的 prompt-response 生命周期"。实际上两条路都必须新建一个 transport 级的**常驻订阅组件**（`SessionStream`）：持有唯一 `session.subscribe`、跑 reconcile 循环（subscribe → getSnapshot → replay → live，断线带 cursor 重订）、同时喂消息 chunk 和 agent-request 事件两个消费面。这部分无论哪条路都要写。

唯一区别：Driver 还要**手写 `UIMessageChunk → UIMessage` reducer**（text/reasoning/tool-part/step 合并），而这正是 AbstractChat 已经正确实现、且最琐碎易错的部分。Driver 方案是纯重复，没有抵消收益。

## 选定方案

1. `OrpcChatSessionTransport` 内新建 per-session `SessionStream`：拥有常驻 `session.subscribe`，暴露 (a)「取 turn T 从 cursor C 起的 chunk 流」给 sendMessages/reconnectToStream，(b) agent-request 事件面。含 reconcile 循环。
2. `sendMessages`：不再 per-prompt 开流，改为从 `SessionStream` 派生新 turn 的 chunk 流。
3. `reconnectToStream`：从 null 改为从 `SessionStream` 派生（replay activeTurn.chunks seq>cursor 后接 live）。
4. `Chat` 子类：mount 时若 snapshot 有 active turn 调 `resumeStream()`；订阅见到非本客户端发起的 `session.turn.started` 且 status=ready 时也调 `resumeStream()`（拉别的客户端的 turn）；`onFinish` 重拉 getMessages 替换。
5. agent-request 面沿用现有 `subscribeAgentRequests` → zustand `pendingRequests`，只是改为复用 `SessionStream` 的同一条订阅，不再另开流。

## 承认的偏差

- AbstractChat 的 `status` 只有 submitted/streaming/ready/error，装不下设计的 `requires_action` 和"别的客户端 turn 在跑"。这些改从 zustand store 读（pendingRequests 已在，新增 activeTurn/phase 来自 snapshot）。AbstractChat status 只反映**本客户端**的 reduce 活动，与会话 phase 解耦——这已是现状架构。
