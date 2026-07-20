---
title: 实现 getMessages(claude-code) 与 turn 提交边界
status: open
assignee:
labels: [wayfinder:task]
blocked-by: [04-claude-code-history-research.md, 08-impl-subscribe.md]
---

## Question

按调研结论实现：

- adapter 历史读取 → 归一化 committed `UIMessage[]`（一个 Agent Loop 一条 assistant 消息），`getMessages` 永远排除当前 active turn。
- messageId 不变量落地：chunk 流 `start.messageId` == 历史最终 `UIMessage.id`，加"chunk 流归并结果 vs 原生历史"对拍测试。
- `session.turn.ended` 改为历史提交确认后发布；提交始终不可读时转 crashed。

产出：实现 + 对拍测试合入。
