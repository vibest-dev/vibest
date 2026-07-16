---
title: 实现 session.list/rename/delete
status: open
assignee:
labels: [wayfinder:task]
blocked-by: [07-impl-create-resume.md]
---

## Question

以元数据目录为索引实现三个方法：

- `list(projectId)`：读 `sessions/<projectId>/*.json`，按 harnessAgentId 合并原生标题/更新时间，补内存状态；原生历史缺失时返回 `historyAvailable: false`。
- `rename`：改 Agent 原生标题；历史缺失返回 `NOT_FOUND`。
- `delete`：活跃则先关实例，再删原生历史 + 元数据文件，发 `session.deleted`；容忍原生历史已不存在。

产出：实现 + 测试合入。
