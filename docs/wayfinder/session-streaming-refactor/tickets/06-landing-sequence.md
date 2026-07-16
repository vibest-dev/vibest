---
title: 落地顺序与兼容策略
status: open
assignee:
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
