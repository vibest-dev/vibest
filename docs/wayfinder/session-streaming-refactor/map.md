---
title: Session 流式契约重构
labels: [wayfinder:map]
---

## Destination

按源设计稿（脱敏副本 `docs/design/session-agent-design.md`，经下方修订约束调整）把 session API 与流式订阅重构**实现落地并合入 main**：`session.create/resume` 走 SessionRef + 元数据持久化，订阅走 scope 过滤 + 会话内 seq + 主动 getSnapshot 对齐，`getMessages` 提供已提交历史，客户端刷新/断联/服务重启三条恢复路径可用，`list/rename/delete` 可用。

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
6. **create**：入参 `{projectId, harnessAgentId, ...}` → 出参 `SessionRef {projectId, harnessAgentId, sessionId}`；sessionId 由 server 生成，adapter 原生 ID 降级为元数据字段 `harnessSessionId`；元数据文件 `~/.vibest/storage/sessions/<projectId>/<sessionId>.json` 原子写；adapter 只见 cwd 不见 projectId；任一步失败不留半初始化状态。
7. **恢复三路径**：刷新（无 cursor，全量重建）/ 短暂断线（带 cursor 续传，turn 变更先用历史收敛旧 projection）/ 服务重启（`SESSION_NOT_ACTIVE` → resume → 走刷新路径），客户端收敛为单个 reconcile 入口。
8. chunk 消费算法：`seq ≤ lastApplied` 幂等忽略；`== +1` 应用并推进；`> +1` 视为缺口重订。
9. **破坏性直改，不做新旧类型并存**（2026-07-16 用户定案，推翻 ticket 01 原本的 additive 前提）：contract 直接重写，下游 server/harness/client/app 随 impl ticket 一次性迁移，中间不维持双份类型。

## Decisions so far

<!-- 一行一个已关闭 ticket：gist + 链接 -->

- [存储与元数据方案](tickets/02-storage-metadata.md) — 不做 allowedRoots（只 realpath+存在性）；project 挂 create+list；元数据与 projects.json 加 version:1 包裹（含存量迁移）；sessionId 纯 uuid、删 id.ts；server 侧新建 SessionService+SessionMetadataRepository 编排层，harness 保持无盘。
- [契约类型定稿](tickets/01-contract-types.md) — 破坏性直改 packages/contract（否决 domain-v2 并存）：SessionRef、phase 状态机、ServerEvent（session 事件带 seq/collection 无序号）、SubscribeStreamEvent（无 gap）、SessionRuntimeSnapshot、PromptInput parts、serverErrors；13 方法契约；contract 独立绿（14 测试），下游 4 包待 impl ticket 迁移。
- [客户端消费形态](tickets/03-client-consumption-shape.md) — 保留 AbstractChat 当 reducer，常驻订阅做成 transport 级 `SessionStream`（否决新建 Driver：两路都要建 SessionStream，Driver 还得重写已有 reducer）；三条恢复路径落在 AbstractChat 原生 replace-vs-push（依赖 messageId 不变量）；reconnectToStream/resumeStream 是续接钩子。
- [落地顺序与兼容策略](tickets/06-landing-sequence.md) — CI 全仓门禁 → 单大分支一次性推平合 main（不拆集成分支）；分支内序 07→08→{09,10}→11→12；无适配 shim；getMessages 空数组接缝仅开发期；event-manifest 迁移归 08；受控调度订阅测试随 08。
- [codex 原生历史与 messageId 调研](tickets/05-codex-history-research.md) — codex 有原生持久化 `Turn.id`，实时 transform 已当 start.messageId 发、`thread/read includeTurns` 可读回同 id，**无需合成**；与 claude-code 共享 fold 架构不共享 id 源；turn.ended 从 `turn/completed` payload 派生。风险：turn.id 跨 resume 稳定性未实测（承重假设，ticket 11 前必验）。
- [claude-code 原生历史与 messageId 调研](tickets/04-claude-code-history-research.md) — 今天完全没连上（实时 start 无 messageId、fold 出空 id）；原生 `getSessionMessages` 有 wire uuid 且跨 resume 存活，但一 turn 多条 assistant，**须合成**（取 turn 首条 assistant uuid）两侧同分段规则复现；turn.ended 须门控在对 getSessionMessages 的有界轮询后。承重风险：compaction/`retracted_message_uuids` 可改写被选 uuid → 破坏 reconciliation。
- [实现 create/resume + Project + 元数据](tickets/07-impl-create-resume.md) — **option A 端口边界**：交付服务端编排层（SessionMetadataRepository + HarnessSessionsPort + SessionService，server↔native id 翻译、projectId→cwd、元数据原子写），fake port 测（6+9 测试绿）；harness 保持无盘。真实 port→harness 适配、project router、rpc/session.ts 接线因 harness 19 文件依赖旧事件模型（加载不了）**归并进 08**。删 id.ts 复合方案。
- [订阅重构 + 服务端 runtime + 全接线](tickets/08-impl-subscribe.md) — **server owns the runtime**：新建 SessionRuntime（会话内 seq / phase 机 / activeTurn / 有界 fan-out 满则 `closed(slow_consumer)`），EventBus 退化为纯 scope fan-out，harness 瘦身为纯 body 流；真实 HarnessSessionsPort + project router + rpc/session 13 方法 + 反查 resolveRef 全接线；app transport 迁到 SessionRef 订阅 + snapshot 重放；无 sleep 订阅测试。合入 PR #118（rebase 到 main、review 通过、全仓 build/test/typecheck 19/19 绿）；`getMessages` 空数组接缝留给 10/11、client reconcile 留给 12。
- [实现 session.list/rename/delete](tickets/09-impl-list-rename-delete.md) — **范围按用户 2026-07-18 调整**（08 后 harness 无状态、原生标题/历史无接口）：list = 元数据 ⋈ 活跃 runtime status（非活跃不带 status）；delete 关实例 + 删元数据 + 发 `session.deleted`（原生历史删除待 harness 面）；**rename 归 harness 原生能力、本 ticket 不做**（留 broadcast-only stub）。`historyAvailable` 暂恒 true（真实判定归 10/11）。server 41 测绿、全仓 19/19 绿。侧边栏消费真实 list 仍待客户端接线。

## Not yet specified

- turn.ended 提交边界已由 04/05 定形（claude-code 有界轮询 getSessionMessages、codex 从 turn/completed payload 派生），具体实现归 ticket 10/11。
- **claude-code messageId 承重风险**：compaction（`compact_boundary`）/ `retracted_message_uuids` 会改写被选中的 turn-首条-assistant uuid → 破坏 reconciliation。缓解策略（换更稳的 id 锚点？committed 侧重映射？）在 ticket 10 内决，可能需回补一张专项 ticket。
- **codex turn.id 跨 resume/重启稳定性未实测**：ticket 11 实现前必须对活二进制验证；若不稳，codex 也退回合成规则。
- 两侧共享的 **turn 分段规则**（历史读缺 result/system 边界帧）需先写对拍测试锁死——ticket 10 起点。
- pi adapter 在新契约下的能力声明与 `UNSUPPORTED` 策略（历史、恢复等）。
- **harness native-title 面（承载 rename）**：08 后 harness 无 title 读写；把会话重命名落到 agent 原生标题需给 harness + 各 adapter 加 title get/set 面。09 暂留 broadcast-only stub、不持久化——可能回补一张专项 ticket。
- **delete 的原生历史删除**：delete 现只删 server 元数据 + 关活跃实例；删除 agent 原生历史需 adapter 面（与 10/11 的原生历史读同源），未做则原生历史遗留在 agent 侧。
- **侧边栏消费真实 session.list**：`app-sidebar.tsx` 仍是 mock；接真实 list（含 status/historyAvailable）归客户端工作，与 12 的 reconcile 同期或独立 UI ticket。
- active-turn buffer 指标落点与后续上限策略（v1 不设上限，先收集数据）。

## Out of scope

- JSON-RPC 2.0 协议更换——用户明确否决，保留 oRPC。
- setModel、配置目录（get/setConfigOption）、元数据 config 持久化与 resume 配置重放——单独立项。
- steer（turn 进行中 prompt 追加输入）——现状 `TurnAlreadyRunning` 拒绝行为保留。
- fs / git / provider / mcp 模块挂载——已建成未挂载的部分不在本图动。
- Project 维度订阅——用户明确否决。
