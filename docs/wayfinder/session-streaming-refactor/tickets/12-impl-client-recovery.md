---
title: 实现客户端重连/刷新路径
status: open
assignee:
labels: [wayfinder:task]
blocked-by: [03-client-consumption-shape.md, 06-landing-sequence.md, 08-impl-subscribe.md]
---

## Question

按"客户端消费形态"决议在 `apps/app` 实现统一 reconcile 入口，覆盖三条路径（既定约束 7/8）：

- 刷新：subscribe 缓冲 → getSnapshot → getMessages → 排干 → live；committed 已含 `activeTurn.messageId` 时丢弃重放。
- 断线/slow_consumer：带 `{turnId, lastAppliedSeq}` 重订；turn 变更先用历史收敛旧 projection。
- 服务重启：`SESSION_NOT_ACTIVE` → resume → 刷新路径。
- turn.ended 后重拉 getMessages 替换临时消息；pendingRequests 水合与事件维护并入同一条订阅，废除 `subscribeAgentRequests` 平行流。
- getMessages 未全部落地期间按"落地顺序"决议留接缝。

产出：实现 + 三条路径的端到端验证（含手动刷新/断网演练）合入。
