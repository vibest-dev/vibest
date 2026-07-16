---
title: codex 原生历史与 messageId 调研
status: open
assignee:
labels: [wayfinder:research]
blocked-by: []
---

## Question

getMessages(codex) 的对应调研（`packages/harness/src/codex/`，app-server thread APIs）：

- thread/item API 能否读回完整已提交历史；resume 后的可用性。
- 归一化为单条 assistant UIMessage 的映射（turn item → parts）。
- chunk 流与历史路径的稳定 id 来源（thread item id？turn id？），与 claude-code 方案能否共用同一合成规则。

产出 markdown 调研（放 `docs/research/`）+ 建议方案。
