---
title: 实现 getMessages(codex)
status: open
assignee:
labels: [wayfinder:task]
blocked-by: [05-codex-history-research.md, 10-impl-getmessages-claude-code.md]
---

## Question

复用 claude-code 落地的归一化框架与对拍测试模式，为 codex 实现 getMessages 与 messageId 不变量；能力不可达的部分返回 `UNSUPPORTED` 而非静默忽略。

产出：实现 + 对拍测试合入。
