---
title: 实现订阅重构：scope 过滤、会话内 seq、慢消费者终止
status: open
assignee:
labels: [wayfinder:task]
blocked-by: [01-contract-types.md, 07-impl-create-resume.md]
---

## Question

按既定约束 2–5 重构服务端流式链路（`event-bus.ts`、`session-service.ts`、`rpc/session.ts`）：

- EventBus 退化为纯 fan-out + scope 过滤（session 按 ref 全等，global 不过滤），去掉 bus 发号。
- seq 由 SessionRuntime 在 projection 折叠处自增（会话内连续），只戳 session 事件；首个 chunk 为带 `messageId` 的 `start`。
- 订阅者有界队列满 → `closed(slow_consumer)` 终止；删除 gap 折叠、`degraded`、`REPLAY_CAPACITY`；buffer 记 count/bytes 指标，turn 结束释放。
- 状态机换 `idle/running/requires_action/crashed`（requires_action 由 pendingRequests 驱动）。
- `subscribe`/`getSnapshot` 新契约上线（snapshot 含 cursor + activeTurn.chunks，供客户端 seq 对齐与重放）。

产出：实现 + 订阅语义测试（受控调度、无 sleep，对齐设计稿 §10.3 精神）合入。
