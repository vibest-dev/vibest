# 多端同步改进报告(对照 OpenCode v2)

对照对象:`sst/opencode` dev 分支(v2 架构,commit `3016830e2`)。
硬约束:**不引入 SQLite,不新增事件日志存储。**

## 0. 为什么"不加 SQLite"是自洽的,而不是妥协

OpenCode v2 自己就是 harness,transcript 是它自己的数据,所以它必须自建耐久层:
`event` + `event_sequence` 表按 per-session 单调 seq 追加,投影器在同一个 SQLite
事务里折叠出 `session_message` 读模型(`packages/core/src/event.ts:237-353`)。它那条
无缝回放流 `/api/session/:id/event?after=<seq>` 的全部保证,来自"可按 seq 范围查库"。

vibest 的 transcript 权威在 harness 手里:claude 的 `~/.claude/projects/**.jsonl`、
pi 的 entry tree、codex 的 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`。我们不需要
造耐久层,**我们需要的是把这个已经存在的地板接全、接稳**。这也意味着 server 重启的
状态损失是有界的:内存投影没了,客户端重连后从原生历史重新水合。

结论:下面所有改进项都不需要新存储。真需要耐久的(P1-1 的收件箱)也应复用现有
`effect-json-store`,而不是为此引入 SQLite。

## 1. 摘要

| #    | 候选                                       | 收益                           | 代价                  | 优先级 |
| ---- | ------------------------------------------ | ------------------------------ | --------------------- | ------ |
| P0-1 | codex 补 `getMessages`(读 rollout jsonl)   | 补上唯一没有历史地板的 harness | 一个 transform + 测试 | 高     |
| P0-2 | `activeTurn.chunks` 加界 + 去掉 O(n²) 复制 | 修真实内存/CPU 隐患            | 小                    | 高     |
| P1-1 | 并发 prompt:硬拒 → 内存收件箱              | 两端同时发不再报错丢弃         | 中                    | 中     |
| P1-2 | turn 失败后历史对账                        | 修实测到的发送端视图偏差       | 小                    | 中     |
| P1-3 | 会话列表的全局 busy 态                     | 未打开的会话也能看到"别处在跑" | 小                    | 中     |
| P2-1 | 客户端 chunk 帧级合并(16ms)                | 高频 tool 输出时的渲染开销     | 小                    | 低     |
| P2-2 | prompt `messageId` 幂等校验                | 重发不再产生两个 turn          | 小                    | 低     |

## 2. 逐项

### P0-1 codex 没有历史地板

**现状**:`packages/server/src/rpc/session.ts:146-158` 的 `getMessages` 只放行
`pi` 和 `claude-code`,codex 一律 `UNSUPPORTED`。客户端把 `UNSUPPORTED` 映射成
`null` 并跳过水合(`apps/app/src/core/chat/chat-transport.ts:480-488`)。

于是 codex 会话的多端一致性完全依赖内存投影:只有当前 turn 的缓冲。
`session.turn.started` 会清掉上一轮缓冲(`session-runtime.ts:126-132`),所以
第二个客户端在第 2 轮打开会话,第 1 轮的内容**永远看不到**;server 重启后全丢。
claude/pi 已经没有这个问题——差的就是 codex 这一块。

**OpenCode 参照**:它靠 SQLite 读模型兜底,任何时候 attach 都能读到上一个耐久边界。
我们的等价物就是原生历史。

**方案**:照 `harness/claude-code/transcript.ts` 的路子写
`harness/codex/transcript.ts`:按文件序解析 rollout jsonl,过滤非会话记录,折叠成
`UIMessage[]`。已确认本机格式为
`~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<sessionId>.jsonl`,首行 `session_meta`
带 `id`/`cwd`,可用 `cwd` 校验并按 sessionId 定位(必要时按日期目录倒序扫)。
然后把 `rpc/session.ts` 的白名单去掉——三个 harness 全支持,这个 gate 本身可以删。

**代价**:一个纯 transform + 单测;无新依赖、无新存储。

**验收**:codex 会话跑两轮 → 第二个客户端冷开 → 两端 transcript 逐字符一致
(与今天 claude/pi 的验收脚本同一套)。

### P0-2 `activeTurn.chunks` 无界,且是 O(n²) 复制

**现状**:`session-runtime.ts:141-148`

```ts
chunks: [...current.activeTurn.chunks, event],
```

每来一个 chunk 就整份复制一次数组:一个 n 块的 turn 累计复制 n²/2 个元素。
同时数组**没有上限**——一次 `grep -r` 的大输出或长文件读取就能把整轮 chunk
全部驻留内存;`toSnapshot`(`:182-196`)每次 `getSnapshot` 还会再整份复制一次,
所以每个重连的客户端都要拉一份完整缓冲。

**OpenCode 参照**:它压根不缓冲 delta——`packages/schema/src/session-event.ts:209`
写死了"stream fragments are live-only",代价是中途加入只能看到上一个耐久边界。
我们的缓冲是**更好的体验**(今天录屏里 B 中途加入能立刻看到流到一半的工具卡),
但必须有界。

**方案**:两处独立的小改动。

1. 用可变数组 + 冻结读(fold 内 `push`,`toSnapshot` 时才 slice),或者保留不可变
   语义但改成分块累积。消除 O(n²)。
2. 给缓冲设上限:超限后丢弃最旧的,并在快照里带 `truncated: true`。客户端见到
   `truncated` 就不吃缓冲,直接走 `getMessages()` 历史读 —— 地板已经在那儿了,
   这是安全的降级。

**上限的定位是保险丝,不是内存管理**(review 中定案):缓冲只存进行中的一轮、
下一轮开始即整体释放,正常运行不需要上限参与;唯一的病理场景是跑飞的 agent
循环(一轮永不结束)。因此数字取"正常使用永远碰不到"的量级——
**65536 块 / 10MiB**——触发即意味着出了别的问题。若真实世界观察到截断,升级
路径是把进行中轮次溢写到临时 jsonl(空间换内存),当前不为极端 Case 建这套
带文件生命周期与写盘错误处理的子系统。

已知妥协:被截断的缓冲当前是**整轮**不渲染、轮次结束后走历史回放——理想行为
是"只缺开头,尾巴照常直播"。做不到的原因是流片段带配对结构(start/delta/end、
工具调用的 start/参数/结果),从中间开始喂会产生孤儿片段弄坏渲染折叠。
需要客户端把尾部过滤到第一个干净 start 为止,归入单消费者重构(§3.5)一并做。

**代价**:contract 加一个布尔字段;客户端 `hydratePendingRequests` 加一个分支。

**验收**:构造一个万块 chunk 的 turn,快照体积与内存占用有上界;
客户端在 `truncated` 下仍能得到完整 transcript(经历史读)。

### P1-1 并发 prompt:硬拒 → 内存收件箱

**现状**:第二个客户端在 turn 运行中发 prompt → `TurnAlreadyRunning` →
`CONFLICT`(`rpc/session.ts:217-220`)→ 客户端弹
"Another client is already running a turn in this session."
(`chat-transport.ts:226-229`)。用户输入被丢弃,要自己重发。

**OpenCode 参照**:prompt 一律**先 admit 后 promote**。写入 `session_input`
(`promoted_seq = NULL`),`steer | queue` 两种投递模式,在 provider turn 边界统一
promote(steer 并入当前轮,queue FIFO 开新轮)——
`packages/core/src/session/input.ts:41-116`、`runner/llm.ts:186-194`。
per-session 串行由 `run-coordinator` 保证。两端同时发,谁也不丢、谁也不覆盖。

**方案**(无存储版):收件箱挂在 `SessionRuntime` 的 projection 上。

- `prompt` 不再直接失败:仍然先广播 `session.prompt.submitted`(现有行为,
  `session-service.ts:512-529`),然后按 harness 能力分流——
  pi 已支持 steer,直接 steer;不支持的进 `pendingPrompts` 队列。
- `turn.ended` 时 drain 队列,起下一轮。
- `pendingPrompts` 进快照,中途加入的客户端能看到"排队中的消息"。
- 保留 `CONFLICT`,但只在队列超限时返回。

**取舍**:server 重启会丢未 promote 的 prompt。考虑到我们连 transcript 都不自存,
这个取舍是自洽的;真要耐久,用 `effect-json-store` 而不是 SQLite。

**代价**:中。碰 projection、session-service、contract 快照、客户端排队渲染。
建议独立成一张票,不要和 P0 混着做。

### P1-2 turn 失败后的历史对账

**现状**(今天实测到的):pi 在代理网络下偶发 `Connection error.`,vibest 这一层
的 turn 以失败结束,但 pi 内部重试成功并把回复写进了自己的 entry tree。结果是
**发送端看到失败、旁观端看到成功回复**,两边分叉;刷新页面后收敛一致
(说明地板是对的,分叉只在发送端的活视图里)。

**方案**:`session.turn.ended` 且 `outcome` 为失败时,客户端做一次历史重读
(或服务端在事件里带一个 `historyMayHaveAdvanced` 提示,客户端据此重读)。
这正是 OpenCode 在 revert 场景用的手法——广播一个信号,让客户端强制
re-resolve(`packages/app/src/context/server-session.ts:979-984`)。

**代价**:小。客户端一个分支 + 一次 `getMessages`。

**验收**:断网构造一次失败 turn,发送端不刷新页面即可收敛到与旁观端一致。

### P1-3 会话列表缺全局 busy 态

**现状**:`useSessionListSync`(`apps/app/src/core/session/session-events-sync.tsx`)
是全局 firehose 的唯一消费者,但它**只处理 collection 事件**(created/updated/
renamed/deleted),session-scoped 事件直接跳过(`:100-101`)。所以另一个客户端
正在跑的会话,在侧边栏列表里没有任何"忙"的迹象——除非你把它打开。

**OpenCode 参照**:`GET /api/session/active` 返回全部运行中会话,启动时拉一次,
**每次 `server.connected` 再拉一次**(`packages/app/src/context/server-sync.tsx:241-264`,
`:547-548`),用来给没打开过的会话播种状态;活跃 session 还免于缓存驱逐。

**方案**:两半。

1. 服务端加一个 `session.listActive`(直接读内存投影,零成本),
   客户端在挂载和每次全局订阅重连后拉一次。
2. `useSessionListSync` 顺带消费 `session.turn.started/ended`,在 list 缓存里
   打 busy 标记(注意用 `queryOptions({input}).queryKey`,不是 `.key()`)。

**代价**:小。

### P2-1 客户端 chunk 帧级合并

**现状**:每个 chunk 事件直接推进 AI SDK store,一次渲染。高频 tool 输出时
这是逐块渲染。

**OpenCode 参照**:`FLUSH_FRAME_MS = 16`(`packages/app/src/context/server-sdk.tsx:218`),
连续的同 part text/reasoning/tool-input delta 在入队时就合并成一个事件,
再包在一个 Solid `batch` 里发出。

**方案**:在 transport → chat store 之间加一层 16ms 合并,只合并连续同类文本 delta;
工具事件与边界事件不合并(顺序语义敏感)。

**代价**:小,纯客户端。注意别破坏 seq 门控——合并发生在 cursor 推进之后。

### P2-2 prompt `messageId` 幂等

**现状**:`messageId` 由客户端提供(`session-service.ts:512-516`),我们不校验重复。
同一 `messageId` 重发(网络重试、用户双击)会走出两个 turn。

**OpenCode 参照**:admission 按 ID 幂等,重复即返回已有;同 ID 不同内容报
`PromptConflictError`(`packages/core/src/session/input.ts:51-52,191-202`)。

**方案**:runtime 记住最近 N 个已接受的 `messageId`,重复且内容一致 → 返回原 turn 的
receipt;内容不同 → `INVALID_ARGUMENT`。做 P1-1 收件箱时顺手做掉。

## 3. 明确不做

- **事件日志 / SQLite 读模型。** 我们的地板是 harness 原生存储,重建一份等于双写,
  并要长期维护与 harness 的对账。
- **重连整体重拉。** OpenCode 的 UI 客户端没有 cursor,靠合成 `server.connected`
  事件触发全量 refetch,为此养出了一套 fetch/live 竞态对账机制
  (`MessageLoadState`、live-wins 合并、orphan part 保护,
  `packages/app/src/context/server-session.ts:216,426-478,1101-1108`)。
  我们的 `seq > cursor` 门控更便宜也更严格,继续走这条路。
  值得注意的是:OpenCode **server 侧有**一条正确的 cursor 流,顺序与我们的
  subscribe→history→replay 是同一个定理(`packages/core/src/event.ts:585-604`),
  但目前只服务于 server↔server 复制,没有 UI 客户端消费。
- **慢消费者背压改造。** 我们已经是"队列满 → 发 `closed{slow_consumer}` → 客户端
  凭 cursor 补齐"(`events/event-bus.ts:74-90`),比 OpenCode 的"丢流 → 全量重拉"更好。

## 3.5 单消费者重构(review 中定案并已落地)

review 中定下三条原则并当场重构:**快照同步状态、事件同步增量、词汇表只有一套
(contract)**。

- **不走 AI SDK 的 `sendMessages` 流式契约,自己实现 prompt**:发送退化为纯
  fire-and-forget RPC(拿 turnId 回执);自己的轮次与别人的轮次走同一条渲染
  路径(常驻订阅)。own-turn 认领、prompt/observer 双平面竞态处理和
  `promptChunks` 的断线恢复逻辑整块删除——它们都是"同一份广播、两个消费者"
  的衍生复杂度。`sendMessages` 原本附送的乐观插入、状态机、错误呈现由 Chat
  自己接管。
- **port 不再造 UI 事件层**:Chat 直接消费 wire 的 `SessionScopedEvent`;
  transport 唯一的合成变体是 `attached`(带快照,服务端没有对应事件因为对它
  是查询)。cursor 门控、折叠、对账策略全在 Chat,transport 只剩订阅重连。
- **状态抄写不推导**:runtime 在发布事件时盖上 post-fold 的 `phase`,侧边栏与
  Chat 均照抄(顺带修正了客户端推导不出 `requires_action` 的问题);
  pendingRequests 由快照整体替换 + 事件加减,删除了 delivered/resolved 差量
  记账。
- **截断尾巴续播**:新加入者对被截断的缓冲先做孤儿片段过滤
  (`sanitize-tail.ts`,按 ai fold 的真实配对规则),从第一个干净开头起直播
  尾巴,轮次结束由历史对账补全开头;断点落在洞里的老观众仍整轮等回放
  (拼接会伪造"看起来完整"的消息)。

## 4. 机制对照

| 维度           | OpenCode v2                      | vibest 现状                              | 本报告后                  |
| -------------- | -------------------------------- | ---------------------------------------- | ------------------------- |
| 传输           | SSE 全局 firehose                | oRPC 单 WS,global + per-session 双 scope | 不变                      |
| delta 持久化   | 不持久化(live-only)              | 不持久化(内存缓冲)                       | 缓冲加界 + truncated 降级 |
| 历史地板       | SQLite 读模型                    | harness 原生存储(claude/pi)              | 补 codex                  |
| 重连恢复       | UI 无 cursor,全量重拉            | snapshot + `seq > cursor`                | 不变                      |
| 中途加入       | 只到上一个耐久边界               | 快照带活跃 turn 缓冲(更强)               | 不变                      |
| 并发 prompt    | 耐久收件箱 + 边界 promote        | `CONFLICT` 硬拒                          | 内存收件箱                |
| 失败 turn 对账 | revert 广播强制 re-resolve       | 无                                       | 失败即重读历史            |
| 列表 busy 态   | `/api/session/active` + 重连重拉 | 无(仅 collection 事件)                   | `listActive` + 事件打标   |
| 背压           | 丢流,逼客户端重拉                | `closed{slow_consumer}` + cursor 补齐    | 不变                      |
