---
title: 客户端消费形态：Transport 改造还是 Driver
status: open
assignee:
labels: [wayfinder:prototype]
blocked-by: []
---

## Question

会话级常驻订阅 + 主动 getSnapshot 对齐 + turn.ended 重拉历史的新消费模型下，客户端选哪个形态：

- **改造现有 `OrpcChatSessionTransport` + `AbstractChat`**（用户倾向）：订阅所有权从 per-prompt 移到会话级，`reconnectToStream` 实现补上，`subscribeAgentRequests` 的平行流合并到同一条订阅。验证 AbstractChat 的 prompt-response 生命周期能否兼容"流不随 prompt 开闭"的模型。
- **新 SessionDriver**：绕开 AbstractChat，自持 reducer + zustand store。

用最小原型对拍两者在三条恢复路径（刷新 / 断线带 cursor / 服务重启）上的复杂度，产出结论 + 原型链接。空 plan 自动放行、pendingRequests 水合逻辑的迁移位置一并定。
