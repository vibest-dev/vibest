---
title: claude-code 原生历史与 messageId 调研
status: closed
assignee: dinq
labels: [wayfinder:research]
blocked-by: []
---

## Question

getMessages(claude-code) 的可行性与 id 稳定性（`packages/harness/src/claude-code/`）：

- Agent SDK 的原生会话历史怎么读（SDK session API？磁盘 jsonl？），resume 后是否完整。
- "一个 Agent Loop = 一条 assistant UIMessage"的归一化：text/reasoning/tool call/tool result/多 step 如何折进同一 parts 数组。
- **关键不变量**：实时 chunk 流首个 `start` chunk 的 `messageId` 能否与历史路径最终 `UIMessage.id` 稳定一致（原生 message uuid？合成规则？），跨 resume 是否稳定。
- `session.turn.ended` 发布前如何确认该 turn 历史已提交可读（设计稿 §7.5）。

产出 markdown 调研（放 `docs/research/`）+ 建议方案。

## Resolution

2026-07-16 调研完成 → [报告](../../../research/2026-07-16-claude-code-history-messageid.md)。

结论：**不变量可达但今天完全没连上，两侧都要改**。

- 现状断裂：实时 `start` chunk（`transform.ts:25`，仅 `system/init` 发）不带 `messageId` → 客户端用 `AbstractChat.generateId()` 随机 id；cold-fold（`fold.ts`）因 `readUIMessageStream` 无 seed 消息，产出 `id === ""`。
- 原生历史：SDK 有 `getSessionMessages(sessionId, {dir})` 读磁盘 JSONL，返回带顶层 wire `uuid` 的 `SessionMessage[]`；同一 `uuid` 出现在实时 `SDKAssistantMessage.uuid` 上、逐字持久化、跨 `query({resume})` 存活。
- **但**：一个 agent-loop/turn 含多条 assistant 消息各有独立 `uuid`，**没有原生 id 命名"这个 turn 的消息"** → 与 codex 的原生 `turn.id` 不同，claude-code **必须合成**。
- 建议：UIMessage id = turn **首条 assistant 消息的 uuid**；实时侧改为惰性发一个带此 id 的 `start`；fold `getSessionMessages()` 时用**同一套 turn 分段规则**复现。共享的 transform/fold 机制已归一化 parts。

**风险（按承重排序）**：

1. **transcript 脆弱**：context compaction（`compact_boundary`）与拒答回退 supersede（`retracted_message_uuids`）可能驱逐/改写被选中 uuid 的那条消息，悄悄改掉 committed turn 的 id → 破坏 reconciliation。
2. **turn 分段漂移**：历史读省略了实时路径有的 `result`/`system` 边界帧，两侧必须用同一套、测过的规则推断 turn 边界。
3. **commit 顺序延迟**：JSONL 写相对实时 `result` 帧是异步的、消息流上无"已落盘"信号 → `session.turn.ended` 必须门控在对 `getSessionMessages` 的有界轮询之后（直到该 turn 的 assistant uuid 可读），不能直接转发 result 帧。

对比 codex（ticket 05）：两者共享 fold 架构、turn=一条 assistant 消息的不变量、以及"turn.ended 需历史可读"要求；但 codex 用原生 turn.id 无需合成、且从 `turn/completed` payload 派生 turn.ended，claude-code 需合成 + 轮询。→ 进 ticket 10 实现时先写"chunk 流归并 vs getSessionMessages 折叠"对拍测试锁死分段规则与 id，再动 codex(11)。
