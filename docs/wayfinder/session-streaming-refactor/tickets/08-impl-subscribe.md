---
title: 实现订阅重构：scope 过滤、会话内 seq、慢消费者终止
status: closed
assignee: dinq
labels: [wayfinder:task]
blocked-by: [01-contract-types.md, 07-impl-create-resume.md]
---

## Question

按既定约束 2–5 重构服务端流式链路（`event-bus.ts`、`session-service.ts`、`rpc/session.ts`）：

- EventBus 退化为纯 fan-out + scope 过滤（session 按 ref 全等，global 不过滤），去掉 bus 发号。
- seq 由 SessionRuntime 在 projection 折叠处自增（会话内连续），只戳 session 事件；首个 chunk 为带 `messageId` 的 `start`。
- 订阅者有界队列满 → `closed(slow_consumer)` 终止；删除 gap 折叠、`degraded`、`REPLAY_CAPACITY`；buffer 记 count/bytes 指标，turn 结束释放。
- 状态机换 `idle/running/requires_action/crashed`（requires_action 由 pendingRequests 驱动）。
- `subscribe`/`getSnapshot` 新契约上线（snapshot 含 cursor + activeTurn.chunks，供客户端 seq 对齐与重放）。

**harness 事件模型迁移（07 调研暴露，本 ticket 承接）**：harness 19 个文件依赖已删的 `SessionEnvelope`/`SessionEvent`/UIMessageChunk-in-envelope 模型、`runtime/rpc.ts` value 级重导已删契约名 → 整个 `@vibest/harness/runtime` 当前加载不了。本 ticket 把 harness 事件/envelope 模型迁到新 `ServerEvent`/`SessionScopedEventDraft`，localize harness 自己的 create/resume 输入类型（不再从 contract 取已删名字），并迁移 `event-manifest.ts` → `SessionScopedEventTypes`/`CollectionEventTypes`（同步改写 `test/event-manifest.test.ts`）。

**从 ticket 07 归并的 RPC 接线**（07 已交付 port 后的服务端编排层）：

- 真实 `HarnessSessionsPort` 适配层（port→`HarnessAgentSessionService`），挂进 layer 图与 `RpcContext`。
- project 契约/router：`project.create`（name 可选、缺省目录名）+ `project.list` 上线。
- `rpc/session.ts` 改用 `SessionService` 收 `SessionRef`，13 方法按新契约；prompt/interrupt/subscribe/getSnapshot 经 `resolveHarnessSessionId` 翻译后到 harness。
- create 成功发 `session.created`（collection event）。

产出：实现 + 订阅语义测试（受控调度、无 sleep，对齐设计稿 §10.3 精神）合入。此 ticket 落地后仓库应重新整体 typecheck 绿（合并点门禁）。

## Seam decision（2026-07-17 用户定案：**server owns the runtime**）

harness↔server 事件缝的承重决定：**harness 退化为纯 per-session agent-SDK/codex 服务，只吐原始事件 body 流 + 生命周期操作；SessionRuntime 归 server。**

- **harness**（`HarnessAgentSessionService` + 各 adapter）不再持 projection / seq / `SessionEventPublisher`。`HarnessAgentSession` 暴露一条 per-session `Stream<SessionScopedEventBody>`（chunk 也进流，为 `session.message.chunk`）+ prompt/interrupt/respond/close/capabilities。harness 不再有 getSnapshot/getStatus（归 server runtime）。只认 native sessionId + cwd。
- **server SessionRuntime**（新建，per active session，按 SessionRef 键）：消费 harness 原始 body 流 → 会话内自增 seq（从 1，仅 session 事件）→ 折叠 projection（phase 机 idle/running/requires_action/crashed、activeTurn{turnId, messageId, chunks}、pendingRequests、cursor）→ 附 ref 得 `SessionScopedEvent` → 有界队列 fan-out（满则 `closed(slow_consumer)`）；服务 getSnapshot/getStatus。messageId 取首个 `session.message.chunk` 的 start id。
- **EventBus** 退化为纯 scope fan-out（session 按 ref 全等、global firehose），收 `ServerEvent`；collection 事件（created/deleted/renamed）由 `SessionService` 直发。
- 相对「harness 留 runtime」方案多搬 ~200 行 projection 到 server，但 SessionRuntime 是 server 概念、snapshot 天然带 ref，用户选定此路。

执行分级（见 task list #1–#8）：①harness 瘦身+类型迁移 → ②server SessionRuntime + EventBus 重写 → ③真实 port + project router + rpc/session 重写 + layer 图 → ④app transport → ⑤订阅语义测试 + 全仓绿。单大分支多提交推进。

## Resolution

全部 5 级执行落地，合入 PR #118（分支 `session-streaming-refactor`，已 rebase 到当前 `main` 之上，Plannotator review 通过，`turbo run build test typecheck` 全仓 19/19 绿）。

- **①harness 瘦身**：`HarnessAgentSessionService` + adapter 退化为纯 per-session body 流（chunk 走 `session.message.chunk`）+ 生命周期操作，不再持 projection/seq/publisher；event-manifest 迁到 `SessionScopedEventTypes`/`CollectionEventTypes`；harness 147 测试绿。
- **②server SessionRuntime + EventBus**：新建 `session/runtime.ts`（per-active-session，按 ref 键，会话内自增 seq、折叠 phase 机 idle/running/requires_action/crashed、activeTurn{turnId,messageId,chunks}、pendingRequests、cursor、有界 fan-out 满则 `closed(slow_consumer)`）；`events/event-bus.ts` 退化为纯 scope fan-out（session 按 ref 全等 / global firehose）。
- **③接线**：真实 `HarnessSessionsPort` 适配层 + layer 图 + `RpcContext`；`project.create/list` router；`rpc/session.ts` 改用 `SessionService` 收 `SessionRef`，13 方法 + 反查 `resolveRef`（sessionId → 全 ref，跨 project 扫元数据）。
- **④app transport**：`OrpcChatSessionTransport` 绑定 SessionRef、`subscribe({scope})` / `getSnapshot` / ref 键 prompt-interrupt-respond；`closed` 触发 snapshot 重放 + 重订。
- **⑤测试**：订阅语义测试（`events.test.ts`、`event-bus-overflow.test.ts`、`rpc-session.test.ts`）无 sleep，受控排空；server 39 测试绿。
- **合并期约定**：`getMessages` 服务端仍返回空数组（接缝，归 ticket 10/11）；client 刷新/重启 reconcile 归 ticket 12。

**从 07 归并的 RPC 接线均已交付**。此 ticket 关闭后解锁 10（getMessages claude-code）与 12（客户端重连/刷新）。
