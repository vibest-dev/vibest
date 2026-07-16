---
title: 实现 session.create/resume + Project 挂载 + 元数据
status: open
assignee: dinq
labels: [wayfinder:task]
blocked-by: [01-contract-types.md, 02-storage-metadata.md, 06-landing-sequence.md]
---

## Question

**分层（2026-07-16 用户强调）**：harness 不感知 Project，到 harness 就是 cwd。所有 projectId/daemon-sessionId/元数据 bookkeeping 在 `packages/server` 新建的 `SessionService` 里；harness 的 `HarnessAgentSessionService` 零改动，继续只认 `workspacePath` + 原生 session id。

必然后果：**daemon sessionId（我们生成的 uuid）≠ harnessSessionId（claude session uuid / codex thread id，后者由 `thread/start` 返回、无法预先指定）**，server `SessionService` 必须持 `daemon sessionId ↔ harnessSessionId` 映射（存元数据文件），每次调 harness 前翻译。

实现（`packages/server/src/`，harness 不动）：

- 新建 `SessionService` + `SessionMetadataRepository`；`ProjectService`（create+list）挂进 layer 图与 `RpcContext`。
- create：`projectId → ProjectService → cwd`（realpath+存在性，**不做 allowedRoots**，见 ticket 02）→ `harness.create(harnessAgentId, {workspacePath: cwd})` → 拿原生 id → 生成 daemon sessionId(uuid) → 原子写 `storage/sessions/<projectId>/<sessionId>.json`（version:1）→ 发 `session.created`(global) → 返回 SessionRef。
- resume：读元数据（daemon sessionId → harnessSessionId + projectId）→ 解析 cwd → `harness.resume({sessionId: harnessSessionId, workspacePath: cwd})`；服务重启后可用。
- rpc/session.ts 重写为收 SessionRef，经 `SessionService` 翻译后调 harness。
- 失败清理：任一步失败不留进程/元数据文件/runtime/流残留（元数据写在 harness 实例建成之后，失败则删文件）。
- projects.json 存量裸数组 → `{version:1, projects}` 迁移。

产出：实现 + 生命周期测试（对齐设计稿 §10.2 相关条目）合入。
