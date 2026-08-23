---
title: 实现 session.list/rename/delete
status: closed
assignee: dinq
labels: [wayfinder:task]
blocked-by: [07-impl-create-resume.md]
---

## Question

以元数据目录为索引实现三个方法：

- `list(projectId)`：读 `sessions/<projectId>/*.json`，按 harnessAgentId 合并原生标题/更新时间，补内存状态；原生历史缺失时返回 `historyAvailable: false`。
- `rename`：改 Agent 原生标题；历史缺失返回 `NOT_FOUND`。
- `delete`：活跃则先关实例，再删原生历史 + 元数据文件，发 `session.deleted`；容忍原生历史已不存在。

产出：实现 + 测试合入。

## Resolution

**范围按用户 2026-07-18 定案调整**：ticket 08 已把 harness 砍成无状态 per-session 服务（仅 `create/resume/prompt/interrupt/respond/close`），原生标题读写与原生历史读/删**当前无任何接口**（原生历史读归 10/11）。用户定：**rename 归 harness/agent 自己的原生能力、本 ticket 不做**；**list = 服务端元数据 ⋈ 活跃 runtime 状态，status 从活跃 SessionRuntime 取**；delete 关活跃实例 + 删元数据（原生历史删除待 harness 面）。

交付（server-only，纳入 PR #118 分支）：

- **list**（`rpc/session.ts`）：把 `SessionService.list` 的每条 `SessionSummary` 与 `SessionRuntimeRegistry.status(ref)` 合并——活跃会话带 `status.phase`，非活跃（`SessionNotActive`，`catchTag` 兜住）不带 status（`SessionSummary.status` 本就 optional）。`historyAvailable` 暂恒 `true`（注释指向 10/11 做真实 per-session 判定）。
- **delete**：维持 `registry.stop → bus.closeSession → SessionService.delete(harness.close + repo.remove，幂等/容忍缺失) → bus.publish(session.deleted)`。
- **rename（当时状态）**：未做服务端持久化，保留现有「校验 ref + 广播 `session.renamed`」的 broadcast-only stub（刷新不留存）；原生标题写入待 harness native-title 面（见 map「Not yet specified」）。后续 `feat/session-rename` 已改为持久化服务端 metadata 的 `title`，并统一 RPC 与事件 payload 使用 `title`。
- **测试**：`session-service.test.ts` 加 delete 单测（关原生 + 删元数据 → list 空）；`rpc-session.test.ts` 抽 `setup()` 复用，加集成测「active 有 status → close 后无 status → delete 后列表空」。server 41 测绿、全仓 `build test typecheck` 19/19 绿、lint/format 干净。

**未接线/遗留**：app 侧边栏仍消费 mock（`components/layout/app-sidebar.tsx`），接真实 `session.list` 归客户端工作（12 或独立 UI ticket）；原生标题（rename）与原生历史删除（delete 的另一半）待 harness 面，已登记入 map「Not yet specified」。
