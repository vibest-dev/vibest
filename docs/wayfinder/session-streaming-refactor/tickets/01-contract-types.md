---
title: 契约类型定稿
status: closed
assignee: dinq
labels: [wayfinder:task]
blocked-by: []
---

## Question

在 `packages/contract` 落地新 wire 类型并定下并存策略：

- `SessionRef { projectId, harnessAgentId, sessionId }`。
- `SubscriptionScope`：`{kind:'session'; ref}` | `{kind:'global'}`。
- `ServerEvent` 联合：所有事件带 `ref`；只有 session 事件带会话内连续 `seq`；`session.message.chunk { turnId, seq, chunk: UIMessageChunk }`；集合事件 `session.created/deleted/renamed` 无序号。
- 订阅流项：`{type:'event'} | {type:'closed'; reason}`（gap 分支删除）。
- `SessionRuntimeSnapshot`：`{ status, pendingRequests, activeTurn: {turnId, messageId, chunks} | null, cursor }`，去掉 `degraded`/`bootId`（重启检测改走 `SESSION_NOT_ACTIVE`）。
- `PromptInput` 改 parts（text 必须支持，file 保形状返回 UNSUPPORTED）；`PromptReceipt` 收敛为 `{ turnId }`。
- 状态机类型：`idle/running/requires_action/crashed` + `activeTurnId`。
- oRPC typed errors 承载 `ServerErrorCode` 语义。

新类型与现有类型并存（additive），旧类型的删除时机归"落地顺序与兼容策略"决定。产出：contract 代码 + schema 单测合入。

## Resolution

2026-07-16 落地。**并存策略被用户否决，改为破坏性直改** `packages/contract`（不新建 domain-v2）。

已实现：

- `packages/contract/src/domain.ts` 重写：保留审批模型（AgentRequest/Response/Grant）、TokenUsage/TurnError、HarnessAgentId、InspectorTarget、SessionCapabilities（配置出图，暂留）；替换 session/event/snapshot/prompt 段。
- 新类型：`SessionRef`（projectId 校验 UUID、sessionId NonEmptyString）、`SessionStatus {phase: idle/running/requires_action/crashed, activeTurnId?}`、`ServerEvent`（`SessionScopedEvent` 带 `seq` + `SessionScopedEventDraft` 无 seq，`CollectionEvent` 无序号）、`isSessionScopedEvent`、`SessionScopedEventTypes`/`CollectionEventTypes` 清单、`SubscriptionScope`（session|global）、`SubscribeStreamEvent`（event|closed，无 gap）、`StreamingCursor {turnId, lastAppliedSeq}`（client-only）、`SessionRuntimeSnapshot {ref, status, pendingRequests, activeTurn{turnId, messageId, chunks}, cursor}`、`PromptInput`（parts 非空、text 非空、file 保形状）、`PromptOutput {turnId}`、`SessionSummary`/`ListSessionsOutput`、`ServerErrorCode`/`serverErrors` 错误图。
- 消息 chunk 从「envelope 里 UIMessageChunk 与 event 并列」改为「包在 `session.message.chunk` 事件里，带 turnId」。
- `session.ts` 契约重写为 13 个方法（create/resume/close/list/rename/delete/getMessages/prompt/interrupt/respondToAgentRequest/getStatus/getSnapshot/subscribe），全部挂 `oc.errors(serverErrors)`；复杂输出（snapshot/messages/list/subscribe 流）用 `type<>()`，server 侧结构化保证。subscribe 单方法收 scope 覆盖 session+global。
- `session-events.ts` 从 domain 重导出 `isSessionScopedEvent` 及事件类型；`index.ts` 去掉对 session-events 的 `export *`（避免与 domain 的 `export *` 重复导出）。
- 新增 `packages/contract/{vitest.config.ts,test/schema.test.ts}` + package.json test 脚本与 vitest 依赖；14 条用例覆盖 SessionRef UUID/非空、PromptInput 非空、subscribe scope 判别、事件分区不相交、错误图完整。**contract typecheck 通过、14 测试全绿。**
- 删除：旧 `SessionEnvelope`/`SessionEvent`/`defineEvent`/`SessionEventDefs`/`GlobalEventDefs`、旧 `SessionStatus`（initializing/closed）、`SessionSnapshot`（degraded/bootId）、`PromptReceipt`、`CreateManagedSession*`、workspacePath 版 Create/ResumeSessionInput、`SessionIdInputSchema`/`SessionEventsInputSchema`。

**已知连带破坏（预期，归后续 impl ticket）**：`packages/server`（rpc/session.ts、session-stream.ts、event-bus.ts、session/id.ts、harness runtime）、`packages/harness`（event-manifest.ts 依赖已删的 SessionEventDefs、adapter.ts 的 workspacePath 输入、session-service.ts）、`packages/client`、`apps/app`（chat-transport.ts 用 isSessionEvent/SessionEventStreamItem）当前都编译不过。contract 包自身独立绿。这些迁移属于 ticket 07/08/12。
