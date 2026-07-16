---
title: Session 流式契约重构
labels: [wayfinder:map]
---

## Destination

按 daemon 设计稿（`~/ObsidianVault/30-Efforts/Work/2026-07-08-daemon-agent-design.md`，经下方修订约束调整）把 session API 与流式订阅重构**实现落地并合入 main**：`session.create/resume` 走 SessionRef + 元数据持久化，订阅走 scope 过滤 + 会话内 seq + 主动 getSnapshot 对齐，`getMessages` 提供已提交历史，客户端刷新/断联/服务重启三条恢复路径可用，`list/rename/delete` 可用。

## Notes

- **本图覆盖执行**：ticket 可以包含实现与合入，不止于决策（覆盖 wayfinder 默认的 plan-only 模式）。
- 写代码前先加载 `karpathy-guidelines` skill；决策类 ticket 用 `/grilling` + `/domain-modeling`；原型用 `/prototype`。
- 参考现状调研入口文件：`packages/contract/src/{session,domain}.ts`、`packages/server/src/rpc/session.ts`、`packages/server/src/events/event-bus.ts`、`packages/harness/src/runtime/session-service.ts`、`apps/app/src/core/chat/chat-transport.ts`、`packages/server/src/project/`（已建成未挂载）。

### 既定设计约束（本图开图前已与用户定案，不再重议）

1. **不换协议**：保留 oRPC over WebSocket，不引入 JSON-RPC 2.0；错误用 oRPC typed errors 承载 `NOT_FOUND`/`SESSION_NOT_ACTIVE`/`CONFLICT` 等语义码。
2. **一个全局 EventBus**，纯 fan-out + 过滤，不承担发号；订阅只有两个维度：`{kind:'session'; ref}`（单会话，有 cursor/重放语义）和 `{kind:'global'}`（firehose，透传所有事件，无 after、无重放、断线不补）。**没有 project 维度。**
3. **snapshot 主动获取**（`session.getSnapshot`），不在订阅流里返回。无丢失边界靠固定顺序：先 subscribe 缓冲 → 后 getSnapshot 拿 cursor → 丢弃缓冲中 `seq ≤ cursor` → 排干 → live。
4. **只有 session 事件带 seq**：由各 SessionRuntime 在 projection 折叠处自增（会话内连续），global/集合事件不带序号、不重放。`StreamingCursor = { turnId, lastAppliedSeq }`。
5. **慢消费者**：订阅者有界队列满 → 发终止性 `closed(slow_consumer)` 踢掉，删除现有 gap 折叠 / `degraded` / `REPLAY_CAPACITY` 机制；active-turn buffer 不设上限，只记 count/bytes 指标，turn 结束释放。
6. **create**：入参 `{projectId, harnessAgentId, ...}` → 出参 `SessionRef {projectId, harnessAgentId, sessionId}`；sessionId 由 Daemon 生成，adapter 原生 ID 降级为元数据字段 `harnessSessionId`；元数据文件 `~/.vibest/storage/sessions/<projectId>/<sessionId>.json` 原子写；adapter 只见 cwd 不见 projectId；任一步失败不留半初始化状态。
7. **恢复三路径**：刷新（无 cursor，全量重建）/ 短暂断线（带 cursor 续传，turn 变更先用历史收敛旧 projection）/ 服务重启（`SESSION_NOT_ACTIVE` → resume → 走刷新路径），客户端收敛为单个 reconcile 入口。
8. chunk 消费算法：`seq ≤ lastApplied` 幂等忽略；`== +1` 应用并推进；`> +1` 视为缺口重订。
9. **破坏性直改，不做新旧类型并存**（2026-07-16 用户定案，推翻 ticket 01 原本的 additive 前提）：contract 直接重写，下游 server/harness/client/app 随 impl ticket 一次性迁移，中间不维持双份类型。

## Decisions so far

<!-- 一行一个已关闭 ticket：gist + 链接 -->

- [存储与元数据方案](tickets/02-storage-metadata.md) — 不做 allowedRoots（只 realpath+存在性）；project 挂 create+list；元数据与 projects.json 加 version:1 包裹（含存量迁移）；sessionId 纯 uuid、删 id.ts；server 侧新建 SessionService+SessionMetadataRepository 编排层，harness 保持无盘。
- [契约类型定稿](tickets/01-contract-types.md) — 破坏性直改 packages/contract（否决 domain-v2 并存）：SessionRef、phase 状态机、DaemonEvent（session 事件带 seq/collection 无序号）、SubscribeStreamItem（无 gap）、SessionRuntimeSnapshot、PromptInput parts、daemonErrors；13 方法契约；contract 独立绿（14 测试），下游 4 包待 impl ticket 迁移。
- [客户端消费形态](tickets/03-client-consumption-shape.md) — 保留 AbstractChat 当 reducer，常驻订阅做成 transport 级 `SessionStream`（否决新建 Driver：两路都要建 SessionStream，Driver 还得重写已有 reducer）；三条恢复路径落在 AbstractChat 原生 replace-vs-push（依赖 messageId 不变量）；reconnectToStream/resumeStream 是续接钩子。

## Not yet specified

- `session.turn.ended` 与历史提交边界（设计稿 §7.5）的不变量最终强度——要等 claude-code/codex 历史调研出结果才能定多严格。
- pi adapter 在新契约下的能力声明与 `UNSUPPORTED` 策略（历史、恢复等）。
- 订阅语义的验收测试基建形态（受控调度、无 sleep，对齐设计稿 §10.3）——随订阅重构实现清晰。
- active-turn buffer 指标落点与后续上限策略（v1 不设上限，先收集数据）。

## Out of scope

- JSON-RPC 2.0 协议更换——用户明确否决，保留 oRPC。
- setModel、配置目录（get/setConfigOption）、元数据 config 持久化与 resume 配置重放——单独立项。
- steer（turn 进行中 prompt 追加输入）——现状 `TurnAlreadyRunning` 拒绝行为保留。
- fs / git / provider / mcp 模块挂载——已建成未挂载的部分不在本图动。
- Project 维度订阅——用户明确否决。
