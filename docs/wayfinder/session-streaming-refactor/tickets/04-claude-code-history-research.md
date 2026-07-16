---
title: claude-code 原生历史与 messageId 调研
status: open
assignee:
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
