---
title: 存储与元数据方案
status: closed
assignee: dinq
labels: [wayfinder:grilling]
blocked-by: []
---

## Question

定下 create/resume/list 依赖的存储细节（`packages/server/src/project/`、`config/paths.ts`、`infra/json-store.ts` 已有雏形）：

- `~/.vibest` 目录布局：`storage/projects.json` 沿用还是调整？`storage/sessions/<projectId>/<sessionId>.json` 确认。
- `SessionMetadata` schema：`{ projectId, harnessAgentId, harnessSessionId, createdAt }`，`config` 字段是否现在留位（本图不写入）。
- `allowedRoots` 的配置来源与缺省值（CLI flag？config.json？无配置时的行为）。
- `ProjectService` 挂进 `RpcContext`/layer 图的方式；`project.create/list/remove` 三个方法本图挂载哪些（create 是 session.create 的硬依赖）。
- 现有 `packages/server/src/session/id.ts` 的 `harnessAgentId:uuid` 复合 ID 方案弃用还是改造。

## Resolution

2026-07-16 grilling 定案：

1. **本图不做 allowedRoots 白名单**。project cwd 校验只补 realpath（解析 symlink）+ 存在性检查；白名单概念推迟到 fs.* 模块立项。理由：agent 拉起后本就能访问任意路径，cwd 白名单挡不住 agent 本身，其真实价值在未来的 fs.* 只读 API。
2. **project 面挂 create + list**，remove 不挂（"项目下有会话则 CONFLICT" 规则随 remove 一起推迟）；`create` 的 `name` 改为可选，缺省取目录名。
3. **元数据文件与 projects.json 都加 `version: 1` 包裹**。`SessionMetadata = { version: 1, projectId, harnessAgentId, harnessSessionId, createdAt }`，不预留 config 位；projects.json 做一次存量迁移（读到裸数组视为 legacy，写回 `{version: 1, projects}`），迁移随「实现 session.create/resume + Project 挂载 + 元数据」落地。
4. **sessionId 为纯 uuid**；`packages/server/src/session/id.ts`（`makeSessionId`/`parseSessionId`）删除，路由信息一律来自 `SessionRef.harnessAgentId`。
5. **server 侧新建编排层**：`packages/server` 新增 `SessionMetadataRepository` + `SessionService`，依赖保留的 `ProjectService`（projectId→path 解析）、生成 sessionId、写元数据，再调 harness 的 `HarnessAgentSessionService`；harness runtime 保持无盘、不知道 projectId。目录布局确认 `$VIBEST_HOME/storage/sessions/<projectId>/<sessionId>.json`。
6. 命名沿用现状不改：Project 的目录字段叫 `path`（设计稿写 cwd），adapter 入参叫 `workspacePath`。
