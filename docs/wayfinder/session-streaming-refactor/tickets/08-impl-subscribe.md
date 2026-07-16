---
title: 实现订阅重构：scope 过滤、会话内 seq、慢消费者终止
status: open
assignee:
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

**harness 事件模型迁移（07 调研暴露，本 ticket 承接）**：harness 19 个文件依赖已删的 `SessionEnvelope`/`SessionEvent`/UIMessageChunk-in-envelope 模型、`runtime/rpc.ts` value 级重导已删契约名 → 整个 `@vibest/harness/runtime` 当前加载不了。本 ticket 把 harness 事件/envelope 模型迁到新 `DaemonEvent`/`SessionScopedEventDraft`，localize harness 自己的 create/resume 输入类型（不再从 contract 取已删名字），并迁移 `event-manifest.ts` → `SessionScopedEventTypes`/`CollectionEventTypes`（同步改写 `test/event-manifest.test.ts`）。

**从 ticket 07 归并的 RPC 接线**（07 已交付 port 后的服务端编排层）：

- 真实 `HarnessSessionsPort` 适配层（port→`HarnessAgentSessionService`），挂进 layer 图与 `RpcContext`。
- project 契约/router：`project.create`（name 可选、缺省目录名）+ `project.list` 上线。
- `rpc/session.ts` 改用 `SessionService` 收 `SessionRef`，13 方法按新契约；prompt/interrupt/subscribe/getSnapshot 经 `resolveHarnessSessionId` 翻译后到 harness。
- create 成功发 `session.created`（collection event）。

产出：实现 + 订阅语义测试（受控调度、无 sleep，对齐设计稿 §10.3 精神）合入。此 ticket 落地后仓库应重新整体 typecheck 绿（合并点门禁）。
