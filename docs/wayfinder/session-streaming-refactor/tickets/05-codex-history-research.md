---
title: codex 原生历史与 messageId 调研
status: closed
assignee: dinq
labels: [wayfinder:research]
blocked-by: []
---

## Question

getMessages(codex) 的对应调研（`packages/harness/src/codex/`，app-server thread APIs）：

- thread/item API 能否读回完整已提交历史；resume 后的可用性。
- 归一化为单条 assistant UIMessage 的映射（turn item → parts）。
- chunk 流与历史路径的稳定 id 来源（thread item id？turn id？），与 claude-code 方案能否共用同一合成规则。

产出 markdown 调研（放 `docs/research/`）+ 建议方案。

## Resolution

2026-07-16 调研完成 → [报告](../../../research/2026-07-16-codex-history-messageid.md)。

结论：**codex 的 messageId 不变量比 claude-code 稳，因为有原生持久化的 `Turn.id`**。

- 实时 transform 已经把 `turn.id` 当 `start.messageId` 发（`transform.ts:170`，有测试佐证）；同一个 `turn.id` 可从 committed history 经 `thread/read { threadId, includeTurns: true }` 的 `Thread.turns[].id` 读回，`thread/resume` 也会填充 turns。
- 因此 **codex 无需合成 id**：一个 assistant UIMessage 对应一个 Turn，两条路径靠原生 `turn.id` 天然对齐。建议建一个类似 claude-code `fold.ts` 的 cold-read mapper，复用实时 transform 保证 id 一致。
- codex 与 claude-code **共享 fold 架构和不变量，但不共享具体 id 来源**（claude-code 实时 `start` 无 messageId 需合成，codex 用原生 `turn.id`）。
- turn.ended commit 顺序：`turn/completed` 通知已带完整 committed Turn（items/status/completedAt），`session.turn.ended` 应从该 payload 派生，不必回读 `thread/read`，规避 flush 延迟。

**最大风险**：`turn.id` 跨 resume / 进程重启的稳定性是从协议类型和文档注释（codex-cli 0.142.5）推断的，**未对活二进制实测**；且 codex 的 `getMessages`/cold-read mapper 尚不存在（`session-service.ts:529` 现返回 `history: []`）。这个 resume 稳定性假设是整个不变量的承重点，进 ticket 11 实现前必须实测验证。
