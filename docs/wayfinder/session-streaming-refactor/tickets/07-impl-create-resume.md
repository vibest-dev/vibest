---
title: 实现 session.create/resume + Project 挂载 + 元数据
status: closed
assignee: dinq
labels: [wayfinder:task]
blocked-by: [01-contract-types.md, 02-storage-metadata.md, 06-landing-sequence.md]
---

## Question

**分层（2026-07-16 用户强调）**：harness 不感知 Project，到 harness 就是 cwd。所有 projectId/server-sessionId/元数据 bookkeeping 在 `packages/server` 新建的 `SessionService` 里；harness 的 `HarnessAgentSessionService` 零改动，继续只认 `workspacePath` + 原生 session id。

必然后果：**server sessionId（我们生成的 uuid）≠ harnessSessionId（claude session uuid / codex thread id，后者由 `thread/start` 返回、无法预先指定）**，server `SessionService` 必须持 `server sessionId ↔ harnessSessionId` 映射（存元数据文件），每次调 harness 前翻译。

实现（`packages/server/src/`，harness 不动）：

- 新建 `SessionService` + `SessionMetadataRepository`；`ProjectService`（create+list）挂进 layer 图与 `RpcContext`。
- create：`projectId → ProjectService → cwd`（realpath+存在性，**不做 allowedRoots**，见 ticket 02）→ `harness.create(harnessAgentId, {workspacePath: cwd})` → 拿原生 id → 生成 server sessionId(uuid) → 原子写 `storage/sessions/<projectId>/<sessionId>.json`（version:1）→ 发 `session.created`(global) → 返回 SessionRef。
- resume：读元数据（server sessionId → harnessSessionId + projectId）→ 解析 cwd → `harness.resume({sessionId: harnessSessionId, workspacePath: cwd})`；服务重启后可用。
- rpc/session.ts 重写为收 SessionRef，经 `SessionService` 翻译后调 harness。
- 失败清理：任一步失败不留进程/元数据文件/runtime/流残留（元数据写在 harness 实例建成之后，失败则删文件）。
- projects.json 存量裸数组 → `{version:1, projects}` 迁移。

产出：实现 + 生命周期测试（对齐设计稿 §10.2 相关条目）合入。

## Resolution

2026-07-17 落地（**option A：端口边界**，用户选定）。

调研发现：契约重写删掉的 `SessionEnvelope`/`SessionEvent` 事件模型被 harness **19 个文件**深度依赖，且 `runtime/rpc.ts` value 级重导已删名字 → 整个 `@vibest/harness/runtime` 运行时加载不了。这套事件模型正是 ticket 08 要重写的东西，所以「create/resume 经真实 harness 端到端」与 08 在 harness 层纠缠。据此按 option A 划边界：**07 交付服务端编排层（隔着 port 用 fake 测），真实 port→harness 适配与 RPC 接线归并进 08。**

已交付（commits `997c6be`、`46e322b`）：

- `SessionMetadata` 类型 + `SessionMetadataRepository`（`storage/sessions/<projectId>/<sessionId>.json`，version:1，sessionId 只做文件名，原子写）；`Paths.sessionsDir`；6 仓库测试。
- `HarnessSessionsPort`（窄 port：create/resume/close，只认 native id + cwd）+ 服务端错误（AgentUnavailable/SessionOpenFailed/SessionResumeFailed/SessionRefMismatch）。
- `SessionService`：projectId→cwd 解析（经 ProjectService）、生成 server uuid sessionId、写元数据、**server SessionRef ↔ harnessSessionId 翻译**（`resolveHarnessSessionId` 供后续 prompt/interrupt/subscribe 复用）、create/resume/close/list；create 失败清理（元数据写失败则关闭 native 不泄漏）。9 服务测试（fake port）覆盖四类错误路径。
- 删除未接线的 `session/id.ts` 复合编码方案 + 其测试 + `InvalidSessionId`。

**归并进 ticket 08 的剩余接线**：①真实 `HarnessSessionsPort` 适配层（port→`HarnessAgentSessionService`）；②project 契约/router（project.create+list 上线）；③`rpc/session.ts` 改用 SessionService 收 SessionRef；④create 发 `session.created`（collection event，需新 EventBus）。harness 无盘、不感知 Project 的分层是本 ticket 的承重不变量。
