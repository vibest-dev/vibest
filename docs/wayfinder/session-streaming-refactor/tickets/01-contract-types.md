---
title: 契约类型定稿
status: open
assignee:
labels: [wayfinder:task]
blocked-by: []
---

## Question

在 `packages/contract` 落地新 wire 类型并定下并存策略：

- `SessionRef { projectId, harnessAgentId, sessionId }`。
- `SubscriptionScope`：`{kind:'session'; ref}` | `{kind:'global'}`。
- `DaemonEvent` 联合：所有事件带 `ref`；只有 session 事件带会话内连续 `seq`；`session.message.chunk { turnId, seq, chunk: UIMessageChunk }`；集合事件 `session.created/deleted/renamed` 无序号。
- 订阅流项：`{type:'event'} | {type:'closed'; reason}`（gap 分支删除）。
- `SessionRuntimeSnapshot`：`{ status, pendingRequests, activeTurn: {turnId, messageId, chunks} | null, cursor }`，去掉 `degraded`/`bootId`（重启检测改走 `SESSION_NOT_ACTIVE`）。
- `PromptInput` 改 parts（text 必须支持，file 保形状返回 UNSUPPORTED）；`PromptReceipt` 收敛为 `{ turnId }`。
- 状态机类型：`idle/running/requires_action/crashed` + `activeTurnId`。
- oRPC typed errors 承载 `DaemonErrorCode` 语义。

新类型与现有类型并存（additive），旧类型的删除时机归"落地顺序与兼容策略"决定。产出：contract 代码 + schema 单测合入。
