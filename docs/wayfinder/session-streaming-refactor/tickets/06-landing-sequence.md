---
title: 落地顺序与兼容策略
status: open
assignee:
labels: [wayfinder:grilling]
blocked-by: [01-contract-types.md, 02-storage-metadata.md, 03-client-consumption-shape.md]
---

## Question

定下 PR 序列与过渡策略，保证每个 PR 合入后 apps/app 可用：

- 新旧 session 方法（`events`/`snapshot` vs `subscribe`/`getSnapshot`、裸 sessionId vs SessionRef）并存窗口多长，客户端何时切换、旧方法何时删除。
- 服务端订阅重构与客户端消费形态改造是否必须同 PR，还是可用适配层分两步。
- getMessages 未落地期间客户端历史收敛留空数组接缝的具体位置。
- 每步的验收口径（现有测试 + 新增受控调度测试的引入时机）。
