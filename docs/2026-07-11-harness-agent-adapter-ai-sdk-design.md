# Harness Agent Adapter + ai-sdk 抽象设计

> 这是 [`2026-07-08-harness-agent-design.md`](./2026-07-08-harness-agent-design.md)（下称"父文档"）的补全稿。父文档把整套 harness agent 运行时（10 个 oRPC 模块、Effect 装配根、事件订阅时序）勾勒得比较全，但把 **agent adapter 抽象** 与 **ai-sdk 消息/事件归一化** 这两块留成了占位——`Message`/`SessionEvent`/`SessionSnapshot` 在父文档 §5.4 是占位类型，事件信封的字段结构在 §8 是待办。本稿把这两块落成可实施的设计，其余 8 个模块沿用父文档不变。
>
> 参考实现：`~/Work/neo-projects/neo-monorepo/packages/server`（下称"参考实现"）的 `features/agent`——`AgentProvider`/`AgentSession` 抽象、双轨事件信封、`SessionEventHub`、两个 provider 的 `transform`。本稿沿用它的**两平面**（渲染面 / 控制面）模型，但省掉显式 track 标签（靠事件命名带点自判别，§3.1），并落到 vibest 的包分层里。

## 1. 目标与范围

给 vibest 的 harness agent 做两层抽象，使 **claude-code** 与 **codex**（以及未来的其它后端）能在同一套接口后面工作：

1. **ai-sdk 抽象**（`@vibest/ai-sdk-harness-agents`）：把任意后端的原生消息流，归一化成 Vercel AI SDK 的 `UIMessage` 渲染流 + 一套跨后端统一的生命周期事件词表。负责"harness agents → ai-sdk 的抽象定义与转换"。
2. **harness agent 抽象**（`@vibest/server` 的 `agent/` 域切片）：Effect 化的 adapter/session 运行时，驱动后端进程、持活跃会话、把原生流喂给 ai-sdk 层做归一化、经事件枢纽扇出。

**范围内**：两平面类型定义、两后端的 transform、adapter/session/repository 接口、会话生命周期不变量、事件枢纽的 seq/快照、Effect 装配。
**范围外**：oRPC 传输层、fs/git/project/provider/mcp/pty/skill 等其它模块（父文档已覆盖）、模型选择（父文档 §8：会话用哪个 model 由 adapter 自己决定）、前端 React 状态层（父文档 §9）。

**本轮落地**：只实现 claude-code adapter；codex 作为一等设计目标（接口、类型、transform 草图都按它验证），但实现留待后续。

## 2. 分层与包边界

收敛成**两个包**，依赖单向向下（`server → ai-sdk-harness-agents`），后者**无运行时依赖**——各后端 SDK（`@anthropic-ai/claude-agent-sdk`、codex 协议）只做 `import type`，不进 bundle：

| 包                                  | 角色                                                                                                                                     | Effect?      | 依赖                                                                                                                                           | 谁消费                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@vibest/ai-sdk-harness-agents`     | ai-sdk 抽象：两平面类型定义 + per-backend 转换 + tools + 冷读折叠                                                                        | ❌ 纯 TS     | `ai`、`zod`、`@anthropic-ai/claude-agent-sdk`（**type-only**：transform/to-session-event 吃 `SDKMessage`）、codex 后端补其 app-server 协议类型 | `server`（归一化）**和前端**（渲染 tool 卡片、类型、`toUIMessage`） |
| `@vibest/server`（`agent/` 域切片） | harness agent 抽象+实现：adapter/session/repository（Effect）+ SessionLifecycle + registry + session-manager + EventBus + SessionService | ✅ Effect v4 | Effect、`ai-sdk-harness-agents`、各后端 SDK/app-server                                                                                         | 只有 `server` 自己                                                  |

**为什么是这两个包，而不是三个**（"消费者测试"）：

- `@vibest/ai-sdk-harness-agents` 独立成包有意义——它被**两个**消费者用：`server` 在 adapter 里做归一化，**前端**（`packages/ui`、`vibest-devtools-client`）渲染工具卡片、消费 `SessionEnvelope` 类型、冷读 `toUIMessage`。前端不能为了拿这些类型/转换而把整个 Effect server + 子进程依赖拖进浏览器包。这跟参考实现把纯类型放独立 `@neo/contract`、让 renderer 不依赖 daemon 是同一个理由。它 Effect-free、依赖极轻。
- **不再有独立的 `@vibest/agents`**——adapter 天生要持子进程（codex app-server）、要 `Scope`/finalizer 管生命周期，本身就是 Effect 的活；它只会被 `server` 一个消费者用。拆成"Effect-free 接口 + server 包装"纯属徒增间接层。因此现有 `packages/agents` 撤销，逻辑并进 `server/src/agent/adapters/`。

> 命名统一：本稿把参考实现的 **Provider** 概念改称 **Adapter**（`HarnessAgentAdapter`、目录 `adapters/`），因为它就是"把某后端适配到统一接口"的适配器。**"provider" 一词在本稿只保留给模型/凭证 Provider**（父文档的 provider 域、`ProviderConfig`、`provider.updated` 事件），两者别混。

### 目录

```
packages/ai-sdk-harness-agents/src/        # 纯 TS,依赖 ai + zod
  types/
    harness-agent-id.ts    # HarnessAgentId = 'claude-code' | 'codex'（判别式源头）
    envelope.ts            # SessionEnvelope / Draft / EnvelopeBody（UIMessageChunk | SessionEvent）+ isSessionEvent
    event.ts               # defineEvent 原语 + 命名/保留动词规范 + TokenUsage / TurnError
    events/                # 就近定义:session.ts / project.ts / pty.ts …（每域一个）
    event-manifest.ts      # 汇总各域 defineEvent → 判别联合(tag=type) + SessionEvent + client 类型
    request.ts             # AgentRequest / AgentResponse（tool | question | plan）
    session.ts             # SessionStatus / SessionSummary / SessionSnapshot / UserInput / CreateSessionConfig / AvailabilityResult
  claude-code/
    ui-message.ts          # ClaudeCodeUIMessage / Chunk / Metadata / DataTypes
    tools/                 # ← 现有 tools 原样迁入（Bash/Read/Edit/…）
    transform.ts           # ← 现有 to-ui-message.ts 泛化:SDKMessage → ClaudeCodeUIMessageChunk
    to-session-event.ts    # SDKMessage → SessionEvent（session.turn.* 等）
    index.ts
  codex/
    ui-message.ts          # CodexUIMessage / Chunk / Metadata / DataTypes
    tools/                 # codex 工具卡片类型
    transform.ts           # app-server notification → CodexUIMessageChunk
    to-session-event.ts    # app-server notification → SessionEvent
    index.ts

packages/server/src/agent/                 # Effect;只有 server 消费
  types.ts                 # HarnessAgentAdapter / HarnessAgentSession / SessionRepository（Effect-typed）+ EnvelopePublish
  errors.ts                # Data.TaggedError:SessionNotFound / HarnessAgentUnavailable / …
  registry.ts              # HarnessAgentRegistry（+ Layer.scoped）
  session-manager.ts       # sessionId → HarnessAgentSession 内存索引（+ Layer.sync）
  session-lifecycle.ts     # SessionLifecycle（控制轨门,保不变量）
  session-service.ts       # HarnessAgentSessionService（冷/热编排,+ Layer）
  adapters/
    claude-code/           # adapter.ts / session.ts / session-repository.ts / sdk-loader.ts / anthropic-env.ts
    codex/                 # adapter.ts / session.ts / app-server.ts / request.ts / session-repository.ts / binary.ts
  # EventBus 复用已存在的 packages/server/src/events/event-bus.ts,agent 切片消费它
```

## 3. ai-sdk 抽象（`@vibest/ai-sdk-harness-agents`）

### 3.1 信封与两平面（无 `kind` 标签，靠 `type` 自判别）

一个会话的实时流有**两个平面**——渲染面（AI-SDK `UIMessageChunk`）与控制面（§3.2 `defineEvent` 事件）。**不需要额外的 `kind` 标签区分它们**：两套 `type` 空间天然不相交——事件 `type` **恒含 `.`**（`namespace.action`，≥2 段），AI-SDK chunk `type` **恒不含 `.`**（`text-delta` / `tool-input-available` … 连字符式）。所以 `body.type` 自身即判别式，`body.type.includes(".")` 就分出两面。信封按 `harnessAgentId` 判别联合：各后端自带 chunk 类型，但**共享同一套 event 词表**。

```ts
import type { InferUIMessageChunk, UIMessage } from "ai";
import type { ClaudeCodeTools } from "../claude-code"; // 现有 InferUITools
import type { CodexTools } from "../codex"; // 后续补

// 每个后端一个 UIMessage 类型（metadata/data-part/tools 各自不同）
export type ClaudeCodeUIMessage = UIMessage<
  ClaudeCodeMetadata,
  ClaudeCodeDataTypes,
  ClaudeCodeTools
>;
export type CodexUIMessage = UIMessage<CodexMetadata, CodexDataTypes, CodexTools>;
export type ClaudeCodeUIMessageChunk = InferUIMessageChunk<ClaudeCodeUIMessage>;
export type CodexUIMessageChunk = InferUIMessageChunk<CodexUIMessage>;

// body = "一个渲染 chunk" 或 "一个 defineEvent 事件"。渲染 chunk 是 UIMessage 的流式片段
// （text-delta / tool-input-available …，非整条 UIMessage;客户端 readUIMessageStream 折回）。
// 两者 type 空间不相交（点 vs 连字符），故一个裸联合即可，无 kind：
type ClaudeCodeEnvelopeBody = ClaudeCodeUIMessageChunk | SessionEvent;
type CodexEnvelopeBody = CodexUIMessageChunk | SessionEvent;

// seq 由 server 的 EventBus 独家盖;adapter 只发 draft（无 seq）。
export type SessionEnvelope =
  | { harnessAgentId: "claude-code"; sessionId: string; seq: number; body: ClaudeCodeEnvelopeBody }
  | { harnessAgentId: "codex"; sessionId: string; seq: number; body: CodexEnvelopeBody };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type SessionEnvelopeDraft = DistributiveOmit<SessionEnvelope, "seq">;

// 判别 helper：type 里有点就是控制事件，否则是渲染 chunk。
export const isSessionEvent = (
  b: ClaudeCodeUIMessageChunk | CodexUIMessageChunk | SessionEvent,
): b is SessionEvent => b.type.includes(".");
```

窄化 `harnessAgentId` 即拿到该后端精确的 chunk 类型，无需 cast。**这里与参考实现有意分道**：neo 用一个显式 track 标签,vibest 靠"事件命名恒带点、AI-SDK chunk 恒不带点"这条自家不变量省掉标签——两套 `type` 命名规范本身就是隔离。

**投递不在信封上声明 scope**：一条逻辑总线，`seq` 按 **aggregate** 单调递增（`aggregate = sessionId ?? "global"`，由 EventBus 依据帧上有无 `sessionId` 决定，见 §4.4）。"谁收到"完全交给订阅端过滤——`subscribe({ session })`（该会话的 message+event，一个游标=单会话流）、`subscribe({ types })`（如侧边栏只要 `session.*` 集合事件）、`subscribe()`（全收）。事件本身不带 `scope`/`droppable` 字段。

### 3.2 事件规范（`event` 轨 + 全局事件统一用 `defineEvent`）

父文档 §5.4 的 `SessionEvent` 占位不再落成一个手写封闭 union，而是 **借鉴 OpenCode v2 的组织方式**：所有 `event` 轨事件（会话内）与全局事件（会话集合、project、pty、provider…）都用同一个原语 `defineEvent` 声明，就近定义、中央汇总。**只借组织，不借存储**——vibest 不引入 OpenCode 的 durable 事件溯源（SQLite event log / projector / replay）：消息内容的真相在各后端原生存储（claude jsonl / codex app-server），另建平行事件日志=两份真相。事件只是**通知**，恢复靠"重拉快照 + 后端原生存储"，见 §3.6 / §4.4 / §7。

> 约束边界：本规范只管 `defineEvent` 事件（控制面）。渲染面的 `UIMessageChunk` 走 AI-SDK 自己的规范（`text-delta` / `tool-input-available` …，连字符式），**不受下面命名规范约束**。反过来,"事件名必须带点"正是把两面在 `type` 层面隔离开的那条不变量（§3.1）——所以事件末段动词后**不允许**再出现连字符式的 AI-SDK chunk 命名,两套系统不互相套嵌。

**命名 `namespace.action`（变长）**

- 全小写；段用 `.` 分隔；段内多词用连字符 kebab（`server.update-available`）。
- **末段 `action` = 过去式动词**（硬性,只描述"已发生的事实"）。
- `namespace` = 1+ 段，深度按需：域即主体、不加实体段（`project.updated`、`session.created`）；多实体域才加实体段（`session.turn.started`、`session.request.asked`）。不强求 3 段——OpenCode 自身从 2 段（`session.created`）到 5 段（`session.next.tool.input.started`）都有。

**保留动词表（闭集；扩展需评审，别造同义词）**

| 语义        | 动词                                          |
| ----------- | --------------------------------------------- |
| 生命周期    | `created` / `updated` / `deleted` / `renamed` |
| 过程边界    | `started` / `ended`                           |
| 请求-应答   | `asked` / `replied` / `rejected`              |
| 异常 / 退出 | `crashed` / `failed` / `exited`               |
| 连接        | `connected` / `disconnected`                  |

**原语（最小面）**

```ts
// 只声明"它是什么"。别的都不进类型:
//   "属于哪条会话" = 发射时帧上的 sessionId(§3.1);
//   "谁收到"       = 订阅端过滤(§4.4),不在事件上声明 scope;
//   "可丢否"       = 只有渲染面的 *-delta chunk 可丢(§3.6);事件一律不设 droppable 字段。
export function defineEvent<T extends string, S extends z.ZodType>(def: {
  type: T;
  schema: S;
}): EventDef<T, S>;

// 就近定义:每个域一个文件,一个 event-manifest.ts 汇成线上判别联合(tag = type)+ client 类型。
// SessionEvent = 会话内事件的联合(由 manifest 生成,非手写)。
export const SessionTurnEnded = defineEvent({
  type: "session.turn.ended",
  schema: z.object({
    turnId: z.string(),
    outcome: z.enum(["completed", "failed", "canceled"]),
    usage: TokenUsageSchema.optional(),
    error: TurnErrorSchema.optional(),
  }),
});
```

**v1 事件目录**（全部合规；`aggregate` 决定 seq 归属，见 §4.4）

| 分组                            | 事件                                                                                                                                               | 帧带 `sessionId`? / aggregate |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| session（会话内，进"单会话流"） | `session.turn.started` / `session.turn.ended`                                                                                                      | 是 / `sessionId`              |
|                                 | `session.request.asked` / `session.request.replied` / `session.request.rejected`                                                                   | 是 / `sessionId`              |
|                                 | `session.crashed`                                                                                                                                  | 是 / `sessionId`              |
| session（集合）                 | `session.created` / `session.updated` / `session.deleted` / `session.renamed`                                                                      | 否 / `"global"`               |
| project / pty / …               | `project.updated` / `pty.created` / `pty.updated` / `pty.exited` / `provider.updated` / `mcp.updated` / `server.connected` / `server.disconnected` | 否 / `"global"`               |

**消息内容不是事件**——它是渲染面的 `UIMessageChunk`（`text-delta` 等,§3.1/§3.6），不在此表内,也没有 `delta` 事件动词（流式增量属渲染面,不属事件目录）。`session.turn.ended` 是 turn 唯一终态，`outcome` 说明怎么结束；后端特有或未建模的信号**不进控制面**——走渲染面（`data-*` part）。

**各事件 `properties` 复用的公共类型**——`schema` 传 zod（`XSchema`），TS 类型即 `z.infer`（`type X = z.infer<typeof XSchema>`），下面按可读性写成等价的 TS 形态：

```ts
export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}; // ← TokenUsageSchema
export type TurnError = { message: string; category: TurnErrorCategory; retryAfterMs?: number }; // ← TurnErrorSchema
export type TurnErrorCategory =
  | "auth_expired"
  | "rate_limited"
  | "context_overflow"
  | "model_unavailable"
  | "network"
  | "cancelled"
  | "unknown";
// session.request.asked.properties = { request: AgentRequest }(见 §3.3)
```

### 3.3 agent 请求（归一化工具审批/提问）

把现有 `ToolPermissionRequest`（`packages/agents/src/claude-code/types.ts`）一般化成三型；`native` 透传原生细节，让审批结果能翻译回后端原生协议：

```ts
export type AgentRequest =
  | {
      type: "tool";
      id: string;
      harnessAgentId: HarnessAgentId;
      toolName: string;
      input: Record<string, unknown>;
      actions: AgentRequestAction[];
      native: unknown;
    }
  | {
      type: "question";
      id: string;
      harnessAgentId: HarnessAgentId;
      questions: AgentRequestQuestion[];
      native: unknown;
    }
  | { type: "plan"; id: string; harnessAgentId: HarnessAgentId; plan: string; native: unknown };

export type AgentResponse =
  | { type: "tool"; behavior: "allow" | "deny"; message?: string; native?: unknown }
  | { type: "question"; answers: { questionId: string; values: string[]; other?: string }[] }
  | { type: "plan"; behavior: "allow" | "deny"; native?: unknown };
```

v1 claude-code 用到 `tool`/`plan`（ExitPlanMode）/`question`（AskUserQuestion）三型；codex 的能力清单只有 `tool`/`question`（对齐参考实现 `CODEX_CAPABILITIES`）。

### 3.4 会话值类型

```ts
export type SessionStatus = {
  status: "initializing" | "running" | "closed" | "crashed";
  isBusy: boolean;
  needsAttention: boolean;
};
export type SessionSummary = {
  sessionId: string;
  harnessAgentId: HarnessAgentId;
  title?: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
export type SessionSnapshot = {
  history: UIMessage[];
  activeTurn: { chunks: SessionEnvelope[] } | null; // 活跃 turn 的渲染 chunk 回放
  pendingRequests: AgentRequest[];
  cursor: number;
}; // cursor = 已见最大 seq
export type UserInput = { text: string };
export type CreateSessionConfig = { workspacePath: string }; // model 由 adapter 自决（父文档 §8）
export type AvailabilityResult = { available: boolean; reason?: string };
```

### 3.5 转换（transform + to-session-event）

**职责切分**——`transform` 只产 `message`（渲染 chunk），`to-session-event` 只产 `event`（控制）；两者都是纯函数，session 消费循环里各调一次。

```ts
// claude-code/transform.ts —— 现有 to-ui-message.ts 的"渲染"部分
export function* transform(msg: SDKMessage): Iterable<ClaudeCodeUIMessageChunk> {
  // system/init                → { type:'start' }
  // assistant.text             → text-start / text-delta / text-end
  // assistant.tool_use         → tool-input-available
  // user.tool_result           → tool-output-available | tool-output-error
  // result.success             → { type:'finish' }        ← UIMessage 流收尾（渲染用）
}

// claude-code/to-session-event.ts —— 新增,把消息流折成控制事件
export function toSessionEvent(msg: SDKMessage, ctx: LifecycleView): SessionEvent | undefined {
  // assistant/user/stream_event 首次活动 → session.turn.started（claude 无显式 turn,由 lifecycle.ensureTurn 合成）
  // result → session.turn.ended { outcome: success?'completed':(interrupted?'canceled':'failed'), usage }
  // 其余 → undefined
}
```

`session.request.asked` **不走消息流**——它是 claude 的 `canUseTool` 回调 / codex 的 server→client 请求，由 session 直接构造 `AgentRequest`、经 `SessionLifecycle.emit(SessionRequestAsked)` 并 publish；客户端 `respondToAgentRequest` 时翻译回原生 `PermissionResult` / app-server reply，成功端发 `session.request.replied`、拒绝端发 `session.request.rejected`。

codex 侧对称：`codex/transform.ts` 把 app-server 的 `turn/*` 通知 → `CodexUIMessageChunk`，`codex/to-session-event.ts` 把 `turn/started`、`turn/completed` → `session.turn.started`/`session.turn.ended`。

### 3.6 冷热两态 + 同源折叠

同一份 `transform(native) → UIMessageChunk` 服务**两个**折叠场景，这是"冷启动=实时流的静态形态"的结构保证（参考实现靠一个 parity 测试钉住，vibest 让它结构上就相等）：

- **热**（实时）：live `UIMessageChunk` 流，UI 端 `readUIMessageStream` 折成 `UIMessage`。
- **冷**（历史/冷启动）：从后端原生存储读出原生行 → 同一个 `transform` → `foldToUIMessages`（即服务端侧的 `readUIMessageStream`）折成 `UIMessage[]`，供 `SessionRepository.getMessages` 与 `getSnapshot.history` 用。

即 `cold = fold(transform(rows))`、`hot = fold(transform(stream))`，两者同构。`foldToUIMessages` 就是现有 `toUIMessage` 的角色（消费渲染面 chunk 折成 `UIMessage[]`），随包更名。

**客户端的"消息 vs 事件"分流 = `isSessionEvent(body)`（一刀，无 kind）。** 客户端订阅一条流,拿到每帧后:`isSessionEvent(body)` 为假 → 渲染 chunk,喂 `readUIMessageStream` 折进 `UIMessage`;为真 → 控制事件,按 `type` 分派到会话状态 / 审批 / 会话列表 / project 等 store。**"消息"不是第二条传输轨,而是从渲染面帧折出来的 read-model**——这正是 OpenCode 客户端 `event-reducer` 的对应物:它对单条事件流按 `type` 路由,把 `message.part.*` 折进 `Message + Part[]`、其余走控制;差别只在它用自家 `message.part.*` 事件、我们用 AI-SDK `UIMessageChunk`。冷读的 `UIMessage[]`(getMessages/snapshot.history)= OpenCode 服务端 projector 折出的消息读模型,冷热同一套 fold 保证一致。

**可丢性 = 渲染面的 `*-delta` chunk**（`!isSessionEvent(body) && body.type.endsWith("-delta")`）：这类增量帧丢了由快照重放补齐（§4.4），是唯一 droppable 的一类；控制事件与非 delta 的渲染帧都要折进快照、不丢。**恢复不做续传/事件溯源**：重连=会话重拉快照、集合重拉列表（父文档 §4.3），事件是通知而非真相源。

## 4. harness agent 抽象（`@vibest/server` 的 `agent/`）

### 4.1 Effect-typed 运行时接口（`agent/types.ts`）

adapter/session/repository 都是**按 id 动态选择的普通 Shape**（不做 `Context.Tag`/`Layer`，对齐父文档 §5 的命名约定），由具体 adapter 生产、Registry 持有。

```ts
import { Effect, Scope } from "effect";
import type { UIMessage } from "ai";
import type {
  HarnessAgentId,
  SessionEnvelopeDraft,
  SessionStatus,
  SessionSummary,
  SessionSnapshot,
  AgentResponse,
  UserInput,
  CreateSessionConfig,
  AvailabilityResult,
} from "@vibest/ai-sdk-harness-agents";
import type { SessionNotFound, HarnessAgentUnavailable } from "./errors";

// session 往这里吐 draft（无 seq）;EventBus 盖 seq 后扇出。adapter 不认识 EventBus——
// server 注入一个"推进 PubSub"的实现（见 §4.4）。
export type EnvelopePublish = (draft: SessionEnvelopeDraft) => Effect.Effect<void>;

export interface HarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly sessionRepository: SessionRepository;
  checkAvailability(): Effect.Effect<AvailabilityResult>;
  login?(): Effect.Effect<unknown>; // 父文档 §8 待办
  createSession(
    config: CreateSessionConfig,
    publish: EnvelopePublish,
  ): Effect.Effect<HarnessAgentSession, HarnessAgentUnavailable, Scope>; // Scope = 会话生命周期
  resumeSession?(
    sessionId: string,
    publish: EnvelopePublish,
  ): Effect.Effect<HarnessAgentSession, SessionNotFound, Scope>;
  getSession(sessionId: string): HarnessAgentSession | undefined;
}

export interface HarnessAgentSession {
  readonly id: string; // `${harnessAgentId}:${uuid}`,冷操作靠前缀路由
  readonly harnessAgentId: HarnessAgentId;
  prompt(input: UserInput): Effect.Effect<void>; // 只提交;结果全从 envelope 流回
  interrupt(): Effect.Effect<void>;
  close(): Effect.Effect<void>;
  getStatus(): Effect.Effect<SessionStatus>; // 由 SessionLifecycle 折叠
  getSnapshot(): Effect.Effect<SessionSnapshot>; // 读内存:history + 活跃 turn replay + pending
  respondToAgentRequest(requestId: string, response: AgentResponse): Effect.Effect<void>;
}

export interface SessionRepository {
  // 每个后端读自己的原生历史存储
  readonly agentId: HarnessAgentId;
  list(): Effect.Effect<ReadonlyArray<SessionSummary>>;
  getMessages(sessionId: string): Effect.Effect<ReadonlyArray<UIMessage>, SessionNotFound>;
  rename(sessionId: string, name: string): Effect.Effect<void, SessionNotFound>;
  archive(sessionId: string): Effect.Effect<void, SessionNotFound>;
  delete(sessionId: string): Effect.Effect<void, SessionNotFound>;
}
```

`createSession` 带 `Scope`——会话内部那条"消费原生流"的循环用 `Effect.forkScoped` 跑成 fiber，`close()` 关 Scope 就顺带中断 fiber + 跑 finalizer（claude 杀子进程 / codex 退订 thread）。

### 4.2 SessionLifecycle（控制轨门）

每个活跃会话一个实例，是控制轨（`event`）的**唯一出口**；所有会话内 `SessionEvent` 只经它 `emit`，保三条不变量：一个 turn 有始有终（`session.turn.started`→`session.turn.ended`）、一个 `session.request.asked` 恰好被一个 `session.request.replied`/`rejected` 收尾一次、会话结束后不再发事件。`message` chunk 绕过它、直接 `publish`。会话结束/崩溃时把未决 request 兜底发 `session.request.rejected`，避免永远挂起。状态是三个正交事实字段（phase / activeTurnId / pendingRequests），`getStatus` 是它们的纯投影。

### 4.3 两后端 session（对称,驱动不同）

|        | claude-code                                       | codex                                               |
| ------ | ------------------------------------------------- | --------------------------------------------------- |
| 驱动   | SDK `query()`（`@anthropic-ai/claude-agent-sdk`） | `codex app-server` 的 JSON-RPC over stdio           |
| 子进程 | **每会话一个**（SDK 拉起）                        | **多会话复用一个 app-server**,会话 = thread         |
| 输入   | `Pushable` 喂 SDK 流式输入;`prompt` 只 push       | `turn/start`（新）/ `turn/steer`（中途）            |
| turn   | 从消息流 `ensureTurn` 合成                        | app-server `turn/started` 通知                      |
| 审批   | `canUseTool` 回调 → `AgentRequest`                | server→client 请求 → `AgentRequest`                 |
| 冷存储 | `~/.claude/projects/<p>/<sid>.jsonl`              | app-server RPC（`thread/list`/`read`,不直接读文件） |

两者内部消费循环都一样：把原生消息 →`transform`（→渲染 chunk）→ publish；→`to-session-event`（→控制事件）→`lifecycle.emit`→ publish。现有 `packages/agents/src/claude-code/agent.ts` 的 `query` 循环 + `canUseTool` 逻辑直接迁进 `adapters/claude-code/session.ts`（Effect 化）。

### 4.4 装配:publish → EventBus,seq/快照

```ts
// session 内部（adapters/claude-code/session.ts）吐一条 draft:
const broadcast = (body: ClaudeCodeEnvelopeBody) =>
  publish({ harnessAgentId: "claude-code", sessionId: this.id, body }); // SessionEnvelopeDraft

// 消费循环（forkScoped 的 fiber）:
for (const chunk of transform(msg)) yield * broadcast(chunk); // 渲染 chunk 直接进 body
const ev = toSessionEvent(msg, lifecycle.view);
if (ev) yield * lifecycle.emit(ev); // lifecycle.emit 内部再 broadcast(event)
```

- **一条总线,全模块共用**：整个 server **只有这一个 `EventBus`/`PubSub`/订阅端点**（复用/扩展 `server/src/events/event-bus.ts`）。不只 session——`project`/`pty`/`provider`/`mcp`/`server` 等业务模块的全局事件(§3.2 目录)也都 `publish` 进同一条;客户端**订阅一次**,靠过滤切视图。对齐 OpenCode 的单条 SSE 流(连 `server.connected` 都在流上)。
- **publish + seq + 快照**：`publish(draft)` = 按 **aggregate**（`draft.sessionId ?? "global"`）盖单调 `seq` → 折叠快照态（`replayLog` = 当前 turn 的渲染 chunk、`pending` = 未决 request）→ `PubSub.publish(envelope)`。**一条总线不等于一个全局 seq**：seq 按 aggregate 走,单会话订阅者拿到的是自己那条无洞序列;全局事件共享 `"global"` aggregate。`session.turn.started` 整体替换 `replayLog`，`session.turn.ended` 只追加不清空（flush 窗口内快照仍能回放整个 turn）。
- **订阅过滤 + 有界扇出**：不在事件上声明物理 scope,"谁收到"全在订阅端——`subscribe({ session })`（该会话的渲染帧+控制事件，一个游标=单会话流）、`subscribe({ types })`（如侧边栏只要 `session.*`/`project.*` 集合事件）、`subscribe()`（全收）；各订阅返回 `Stream<SessionEnvelope | Control>`。**每订阅者一个有界队列**：慢消费者积压溢出 → 给它发 `gap` → 它重拉快照补齐,不阻塞其他订阅者（`ping`/`gap` 见父文档 §4.3）。
- **无事件溯源**：EventBus 只维护"当前快照折叠态"（内存，随会话关闭 `dropSession` 丢弃），不持久化事件日志。真相在后端原生存储；渲染面 `*-delta` 帧丢了由快照重放补，其余帧折进快照。
- **EnvelopePublish** 就是 `(draft) => eventBus.publish(draft)`，由 `HarnessAgentSessionService.create` 在调 `adapter.createSession` 时注入。
- **快照**（`session.getSnapshot`）：同步冻结 `{ cursor: seq, replayLog, pending }` + 冷读 history（`replayLog` 非空则按 turn 边界切、否则整段，见 §3.6 冷读折叠），客户端用 `cursor` 去重实时流、`bootId` 变化则重新拉快照（父文档 §4.3）。

### 4.5 装配根（接父文档 §6）

```ts
const HarnessAgentRegistryLayer = Layer.scoped(
  HarnessAgentRegistry,
  Effect.gen(function* () {
    const claude = yield* makeClaudeCodeAdapter; // 无常驻进程
    const codex = yield* makeCodexAdapter; // acquireRelease:拉起 app-server,release 里 kill
    return makeRegistry([claude, codex]);
  }),
);
```

codex app-server 的常驻子进程生命周期完全交给 `Layer.scoped` + `Effect.acquireRelease`，根 `Scope` 关时 finalizer 逆序 kill——不用手写 `dispose()`（父文档 §6）。`HarnessAgentSessionService`/`HarnessAgentSessionManager`/`SessionRepository` 都沿用父文档 §5.2 的定义，`create` 拿 `EnvelopePublish` 注入、`register` 进 manager，冷方法靠 `sessionId` 前缀切出 `harnessAgentId` 路由到对应 adapter 的 `sessionRepository`。

## 5. 数据流

- **create**：`session.create` → `SessionService.create` 解析 workspacePath → `registry.get(id).createSession(config, eventBus.publish)`（fork 消费循环 fiber）→ `sessionManager.register` → 返回 `{ sessionId }`。
- **prompt**：`session.prompt` → `sessionManager.get` → `session.prompt(input)`（只 push 输入）→ 结果作为 `message`/`event` 从消费循环经 EventBus 扇出，**不 await 完成**。
- **event**：native msg → `transform`→渲染 chunk + `to-session-event`→控制事件 → `lifecycle`（控制面）→ `publish` → EventBus 按 aggregate 盖 seq → `PubSub` → 订阅（`{session}`/`{types}`/全收）的 `Stream` → oRPC event iterator → 客户端。
- **审批**：native 审批请求 → session 存 resolver + `lifecycle.emit(session.request.asked)` → 客户端 `respondToAgentRequest` → 找 resolver、翻译回原生、触发 + `emit(session.request.replied | session.request.rejected)`。
- **snapshot / 重连**：`session.getSnapshot` 同步冻结 → 客户端覆盖本地态、按 `cursor` 去重续接实时流。

## 6. 迁移路径

不一次性推翻,分步切:

1. **建 `@vibest/ai-sdk-harness-agents`**：把 `packages/ai-sdk-agents/src/claude-code/{tools,schema,utils/to-ui-message}` 迁入，新增 `types/*`、`claude-code/{transform,to-session-event}`、`codex/*`。旧 `packages/ai-sdk-agents` 删除（或先保留 re-export 垫片，一版后删）。
2. **建 `server/src/agent/`**：把 `packages/agents/src/claude-code/agent.ts` 的 `query` 循环 + `canUseTool` + `Pushable` 迁入 `adapters/claude-code/session.ts`（Effect 化）；补 `types.ts`/`errors.ts`/`registry.ts`/`session-manager.ts`/`session-lifecycle.ts`/`session-service.ts`。`packages/agents` 删除。
3. **切 `server-rpc`**：现有 `routes/claude-code.ts` 直接引 `ClaudeCodeAgent`——改成引父文档 §4.2 的 `session.*` oRPC 契约、委托给 `HarnessAgentSessionService`。可先加一层适配把旧 `claudeCodeContract` 映射到新 service，前端不动；再逐步把前端切到 `SessionEnvelope` 两平面事件流。
4. **codex adapter** 留待后续独立 PR（app-server + transform + session-repository）。

## 7. 开放问题（并入父文档 §8）

- **已定：不做事件溯源**。曾评估 OpenCode v2 的 durable（SQLite 事件日志 + projector + replay），本稿**只借它的组织**（统一 `defineEvent` + 点分命名 + 就近定义 + 中央 manifest + 一条总线/订阅过滤），**不借存储**：消息真相在后端原生存储（claude jsonl / codex app-server），恢复靠"重拉快照 + 后端原生存储"而非事件回放。仅当将来要**多端同步**才重新考虑引入 durable。
- **事件版本化策略（微决策，默认已选）**：无事件溯源 ⇒ schema 演进直接**新铸一个 `type`**（如 `session.turn.ended.v2` 或新语义新名），不在 `type` 里内嵌 version、不做迁移。留待真有破坏性演进时再评审。
- **保留动词表扩展（微决策）**：v1 闭集见 §3.2。新增动词（如 `progress`/`succeeded`/`queued`）须走评审、优先复用现有词，避免同义词漂移。
- **`message` payload 粒度**：定为"UIMessage 的流式 chunk"（非整条），客户端折叠。若某后端只给整条消息，transform 需自行切成起止 chunk——待 codex transform 落地时验证。
- **codex tool 类型**：`CodexTools`/`CodexUIMessage` 的 `data-*` part 具体字段随 codex app-server 协议定，本稿只占位。
- **`AgentRequest` 三型的 v1 范围**：claude-code 三型全上（tool/plan/question）；codex 两型（tool/question）。`native` 字段的确切结构随各后端审批协议定。
- **`SessionSnapshot` 的 turn 边界切法**：claude-code 用"上一 turn 尾行 jsonl uuid"、codex 用"当前 turn id"（参考实现两套 `TurnBoundary` 语义）——本稿先只定义 `getSnapshot` 契约，边界 uuid 的获取待各 adapter 实现时补。
- 其余（EventBus 背压阈值/ping 间隔、`sessionId` 前缀路由是否对客户端不透明、Effect v4 最终 API、错误契约的完整 tagged error 列表）沿用父文档 §8 未决项。
