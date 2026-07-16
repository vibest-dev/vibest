---
title: 实现 session.create/resume + Project 挂载 + 元数据
status: open
assignee:
labels: [wayfinder:task]
blocked-by: [01-contract-types.md, 02-storage-metadata.md, 06-landing-sequence.md]
---

## Question

按既定约束 6 实现（`packages/server/src/rpc/`、`packages/harness/src/runtime/session-service.ts`）：

- `ProjectService` 挂进 layer 图；router 层解析 projectId → cwd（realpath + allowedRoots），adapter 只收 cwd。
- Daemon 生成 sessionId；`build()` 流程插入元数据文件原子写；ServiceState 三张 map 改用 Daemon sessionId 做 key，每次调用核对 ref 三字段。
- resume 从元数据文件 + `harnessSessionId` 恢复；服务重启后可用。
- 失败清理：任一步失败不留进程/元数据文件/runtime/流残留。
- 向 global scope 发 `session.created`。

产出：实现 + 生命周期测试（对齐设计稿 §10.2 相关条目）合入。
