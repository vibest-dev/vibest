---
title: 落地顺序与兼容策略
status: closed
assignee: dinq
labels: [wayfinder:grilling]
blocked-by: [01-contract-types.md, 02-storage-metadata.md, 03-client-consumption-shape.md]
---

## Question

**前提已变**：ticket 01 已破坏性重写 contract（无新旧并存，map 约束 9）。contract 包独立绿，但 server/harness/client/app 当前编译不过。本 ticket 定的是"怎么把这 4 个包迁回绿并合入"，不再是并存窗口。

- 迁移用一条长命名分支一次性推平，还是拆成几个内部 PR（contract 已合 → server+harness → client+app）？若拆，中间 PR 允许仓库暂时红到什么程度（turbo typecheck 是否必须每步全绿）。
- 服务端订阅重构（ticket 08）与客户端消费形态改造（ticket 12）是否必须同 PR，还是可用适配层分两步。
- getMessages 未落地期间客户端历史收敛留空数组接缝的具体位置。
- 每步的验收口径（现有测试 + 新增受控调度测试的引入时机）。
- harness `event-manifest.ts` 依赖已删的 `SessionEventDefs`/`GlobalEventDefs`，迁移到新的 `SessionScopedEventTypes`/`CollectionEventTypes` 清单归哪个 impl ticket。

## Resolution

2026-07-16 定案。CI 事实：`.github/workflows/quality.yml` 每个 PR 跑 `turbo run build test typecheck` **全仓库**，任何让某包变红的中间状态都合不进 main。

1. **单大分支一次性推平**（用户选定）：`session-streaming-refactor` 一条分支把 contract+server+harness+client+app 全迁完，全仓 `turbo build test typecheck` + lint/format 绿了再一次性合 main。不拆集成分支、不维持中间态。破坏性改动没有并存窗口（map 约束 9）。
2. **分支内实现顺序**按 blocked-by 依赖图：07(create/resume+Project 挂载+元数据) → 08(订阅重构：scope 过滤/会话内 seq/慢消费者/event-manifest 迁移) → {09(list/rename/delete), 10(getMessages claude-code)} → 11(getMessages codex) → 12(客户端 SessionStream+recovery)。每张 = 分支上一个逻辑提交。
3. **subscribe(08) 与 client(12) 不做适配层 shim**：单分支无中间 main 合入，直接迁移。
4. **getMessages 空数组接缝降级为纯开发期脚手架**：合并点 getMessages(10/11) 必然已落地，接缝仅在 12 开发期临时用、合并前移除，不作为发布接口。pi 的 getMessages 返回 `UNSUPPORTED`。
5. **event-manifest 迁移归 ticket 08**（`SessionEventDefs`/`GlobalEventDefs` → `SessionScopedEventTypes`/`CollectionEventTypes`），随事件/流重构一起；`test/event-manifest.test.ts` 同步改写。
6. **验收节奏**：每张 ticket 落分支时尽量让自身包绿；全仓门禁只需在合并点通过。受控调度（barrier/scheduler，无 sleep）的订阅语义测试随 08 引入。
