---
title: 客户端消费形态：Transport 改造还是 Driver
status: closed
assignee: dinq
labels: [wayfinder:prototype]
blocked-by: []
---

## Question

会话级常驻订阅 + 主动 getSnapshot 对齐 + turn.ended 重拉历史的新消费模型下，客户端选哪个形态：

- **改造现有 `OrpcChatSessionTransport` + `AbstractChat`**（用户倾向）：订阅所有权从 per-prompt 移到会话级，`reconnectToStream` 实现补上，`subscribeAgentRequests` 的平行流合并到同一条订阅。验证 AbstractChat 的 prompt-response 生命周期能否兼容"流不随 prompt 开闭"的模型。
- **新 SessionDriver**：绕开 AbstractChat，自持 reducer + zustand store。

用最小原型对拍两者在三条恢复路径（刷新 / 断线带 cursor / 服务重启）上的复杂度，产出结论 + 原型链接。空 plan 自动放行、pendingRequests 水合逻辑的迁移位置一并定。

## Resolution

2026-07-16 定案（用户确认）：**保留 `AbstractChat` 当消息 reducer，常驻订阅做成 transport 级组件**，不新建绕开 AbstractChat 的 Driver。

判决依据是 `ai@7.0.22` 源码事实而非抛弃型 UI 原型：AbstractChat.makeRequest 每 chunk 判断 `streaming.message.id === lastMessage.id ? replaceMessage : pushMessage`，streaming id 由流的 `start.messageId` 决定——这正是设计稿 §7.4 的归并，三条恢复路径全落在此机制上，前提是 messageId 不变量（ticket 04/05）成立。`resumeStream()`/`reconnectToStream` 是 SDK 为"续接非本次 sendMessage 发起的流"准备的钩子。

关键推翻的前提：Driver **不能**绕开生命周期省事——两条路都必须新建同一个 transport 级常驻订阅组件（`SessionStream`：唯一 subscribe + reconcile 循环 + 消息/agent-request 双消费面）。Driver 额外要手写 `UIMessageChunk→UIMessage` reducer（AbstractChat 已正确实现的琐碎部分），是纯重复无收益。

选定落地形状（详见 [调研笔记](../../../research/2026-07-16-client-consumption-shape.md)）：

1. `OrpcChatSessionTransport` 内建 per-session `SessionStream`（常驻 subscribe，暴露"取 turn T 从 cursor C 起的 chunk 流" + agent-request 事件面 + reconcile）。
2. `sendMessages` 从 SessionStream 派生新 turn 流（不再 per-prompt 开流）。
3. `reconnectToStream` 从 null 改为从 SessionStream 派生（replay seq>cursor 后接 live）。
4. `Chat` 子类：mount 时 snapshot 有 active turn 则 `resumeStream()`；见到非本客户端的 `session.turn.started` 且 status=ready 也 `resumeStream()`；`onFinish` 重拉 getMessages 替换。
5. agent-request 面沿用 `subscribeAgentRequests`→zustand pendingRequests，改复用 SessionStream 同一订阅。

承认的偏差：AbstractChat.status（submitted/streaming/ready/error）装不下 `requires_action` 和"别客户端在跑 turn"；这些从 zustand store 读（activeTurn/phase 来自 snapshot），AbstractChat status 只反映本客户端 reduce 活动。此偏差已是现状架构。
