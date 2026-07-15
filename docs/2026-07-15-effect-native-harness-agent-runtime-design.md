# Effect Native Harness Agent Runtime 改造设计

> 日期：2026-07-15
> 状态：Reviewed — 已按 Claude Fable 架构审查修订
> 范围：`packages/harness` Agent runtime、`packages/server/src/rpc` 接入层，以及负责创建和关闭 server runtime 的 `packages/vibest`、Electron backend 和 CLI shutdown 路径
> 相关文档：
>
> - [`2026-07-08-harness-agent-design.md`](./2026-07-08-harness-agent-design.md)
> - [`2026-07-11-harness-agent-adapter-ai-sdk-design.md`](./2026-07-11-harness-agent-adapter-ai-sdk-design.md)
>
> 本文细化并修正上述文档中的 Agent runtime 落地方式。两平面消息模型、AI SDK render transform 和 session event 词表继续沿用；Agent 的副作用、并发、错误和资源生命周期改为 Effect Native。

## 1. 背景

当前 `packages/server` 已使用 Effect v4，但 `packages/harness` 中真正驱动 Claude Code 和 Codex 的实现仍是 Promise-based runtime。Server 只是把普通对象包进 `Context.Service`，并在 oRPC procedure 中通过 `Effect.promise` 调用。

当前主要实现：

- `packages/harness/src/claude-code/agent.ts`
- `packages/harness/src/codex/agent.ts`
- `packages/harness/src/codex/app-server.ts`
- `packages/harness/src/utils/pushable.ts`
- `packages/server/src/rpc/claude-code.ts`
- `packages/server/src/rpc/codex.ts`
- `packages/server/src/rpc/handlers.ts`

现状可以概括为：

```text
Effect oRPC procedure
        │
        │ Effect.promise
        ▼
Promise / AsyncGenerator Agent class
        │
        ├── mutable Map
        ├── custom Pushable
        ├── Promise resolver
        ├── manual child-process cleanup
        └── throw Error
```

这使 Effect 只能管理 RPC handler 的外层执行，无法完整管理 Agent runtime 的错误、取消、并发和资源释放。

## 2. 目标

改造后的 Agent runtime 必须满足：

1. Agent 能力的公开 interface 返回 `Effect` 或 `Stream`，不返回 `Promise` 或 `AsyncGenerator`。
2. 所有预期失败进入 Effect 的类型化错误通道。
3. Claude query、Codex app-server、session consumer fiber 和 pending approval 都受 `Scope` 管理。
4. 使用 Effect 原生并发原语替代自制并发设施：
   - `Queue`：输入和 callback bridge；
   - `Deferred`：RPC correlation 和权限等待；
   - `Ref` / `SynchronizedRef`：共享状态；
   - `Stream`：Agent 输出；
   - `Fiber`：后台消费循环。
5. Server 只调用统一的 Agent session service，不直接操作 Claude/Codex 内部对象。
6. 保持现有 AI SDK render chunk 和 session control event 两平面模型。
7. 迁移期保持现有 RPC 行为，包括 Claude 每 turn 的 model、复合 message parts 和原生 capability wire shape。
8. Codex app-server 保持 lazy start，并能在意外退出后由下一次操作重新启动。
9. Session event pump、兼容 façade 和 EventBus 的订阅时序明确，不丢 turn 开头或尾部事件。
10. EventBus 对慢订阅者使用有界缓冲和 gap/recovery 策略，不允许 render chunk 导致无界内存增长。
11. Root runtime 关闭后不得遗留子进程、process listener、pending request 或后台 fiber。

## 3. 非目标

本次不做：

- 不重新设计 AI SDK `UIMessageChunk` 格式。
- 不重写 Claude/Codex 的纯 `transform` 和 `toSessionEvent` 语义。
- 不给 `packages/harness/src/codex/protocol/` 下的全部生成类型手写 runtime Schema。
- 不同时重写前端 transcript、tool card 和 chat store。
- 不引入 durable event sourcing；恢复仍依赖后端原生历史和 session snapshot。
- 不为了形式统一，把纯函数包装成 `Effect.succeed`。

## 4. Effect Native 的判定标准

“Effect Native”不是所有函数都返回 Effect，而是所有副作用和生命周期都由 Effect 建模。

| 能力         | 当前实现                      | 目标实现                                                            |
| ------------ | ----------------------------- | ------------------------------------------------------------------- |
| 异步操作     | `Promise`                     | `Effect<A, E, R>`                                                   |
| 连续输出     | `AsyncGenerator` / `Pushable` | `Stream<A, E, R>`                                                   |
| 输入队列     | 自制 `Pushable`               | `Queue`                                                             |
| 等待一次响应 | Promise resolver              | `Deferred`                                                          |
| 共享状态     | mutable `Map`                 | `Ref<HashMap>` / `SynchronizedRef`                                  |
| 后台循环     | 隐式 iterator 消费            | scoped `Fiber`                                                      |
| 子进程       | 手工 `spawn` / `kill`         | `ChildProcessSpawner` + `Scope`；必要时回退 `Effect.acquireRelease` |
| 取消         | `AbortSignal`、手工 interrupt | Fiber interruption + finalizer                                      |
| 错误         | `throw Error`                 | tagged error in `E` channel                                         |
| 依赖装配     | `new Agent()`                 | `Context.Service` + `Layer`                                         |
| 测试替身     | mock module / fake class      | test `Layer`                                                        |

纯函数继续保持纯函数：

- `claude-code/transform.ts`
- `claude-code/to-session-event.ts`
- `codex/transform.ts`
- `codex/to-session-event.ts`
- `render-policy.ts`
- request/response 的纯协议映射

### 4.1 T3 Code 调研校验

对 [`pingdotgg/t3code@3513fa0`](./2026-07-15-t3code-effect-agent-integration-research.md) 的源码调研确认了以下模式：

- provider adapter 是普通 Shape，Registry/Service 才使用公共 Context tag；
- Claude 输入用 `Queue → Stream.toAsyncIterable`，输出用 `Stream.fromAsyncIterable`；
- SDK Promise callback 通过构造期捕获的 Effect Context 运行 Deferred-backed Effect；
- Codex/ACP transport 使用 typed Effect Schema、Deferred request correlation、scoped fibers；
- 子进程优先通过 `effect/unstable/process/ChildProcessSpawner` 和 `@effect/platform-node` 接入；
- provider instance/session 使用独立 child Scope；
- root server 由单个 Effect Layer 启动和关闭；
- 新 Effect 测试使用 `@effect/vitest` 和显式 drain/barrier，而不是固定 sleep 或手工 runtime runner；
- `Schema.decodeUnknownEffect` 等编译器应提升到模块级，避免在热路径重复编译。

本设计不照搬 T3 Code 的三点：T3 大量使用 unbounded Queue/PubSub；Codex 是每 session 一个 app-server；active session ownership 分散在 adapter map、ProviderService 和持久化目录。Vibest 继续使用有界订阅、共享 lazy Codex transport 和唯一 active-session owner。

## 5. 包和导出边界

当前 `@vibest/harness/claude-code` 同时导出浏览器需要的 tool/UI 类型和 Node-only Agent class。建议将共享定义与 runtime 导出分离。

```text
packages/harness/src/
├── types/                         # 共享值、Effect Schema、envelope
├── events/                        # 共享 session/global events
├── runtime/
│   ├── adapter.ts                 # HarnessAgentAdapter / HarnessAgentSession
│   ├── errors.ts                  # typed errors
│   ├── registry.ts                # adapter registry
│   ├── session-lifecycle.ts       # lifecycle reducer and invariants
│   ├── session-service.ts         # active sessions、single-flight、child scope、event pump
│   └── index.ts
├── claude-code/
│   ├── tools.ts                   # browser-safe
│   ├── ui-message.ts              # browser-safe
│   ├── transform.ts               # pure
│   ├── to-session-event.ts        # pure
│   └── runtime/
│       ├── adapter.ts
│       ├── session.ts
│       ├── sdk.ts                 # Anthropic SDK seam
│       └── layer.ts
└── codex/
    ├── tools.ts                   # browser-safe
    ├── ui-message.ts              # browser-safe
    ├── transform.ts               # pure
    ├── to-session-event.ts        # pure
    └── runtime/
        ├── adapter.ts
        ├── session.ts
        ├── transport.ts           # JSONL app-server transport
        └── layer.ts
```

目标 exports：

```jsonc
{
  "exports": {
    ".": "./src/index.ts",
    "./runtime": "./src/runtime/index.ts",
    "./claude-code": "./src/claude-code/index.ts",
    "./claude-code/runtime": "./src/claude-code/runtime/index.ts",
    "./codex": "./src/codex/index.ts",
    "./codex/runtime": "./src/codex/runtime/index.ts",
  },
}
```

迁移期间可以从旧 subpath re-export runtime，但新代码必须从 `*/runtime` 导入。前端只依赖 browser-safe subpath。

## 6. 核心 interface

### 6.1 HarnessAgentAdapter

Adapter 是按 `HarnessAgentId` 动态选择的普通 Shape，不为每个 adapter 建立独立公共 Tag。

```ts
import type { Effect, Scope } from "effect";

export interface HarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly descriptor: AgentDescriptor;

  readonly checkAvailability: Effect.Effect<
    AvailabilityResult,
    ExecutableNotFound | AgentUnavailable
  >;

  readonly openSession: (
    config: CreateSessionConfig,
  ) => Effect.Effect<HarnessAgentSession, AgentOpenError, Scope.Scope>;

  readonly resumeSession: (
    sessionId: string,
  ) => Effect.Effect<
    HarnessAgentSession,
    SessionNotFound | SessionNotResumable | AgentOpenError,
    Scope.Scope
  >;
}
```

`openSession` / `resumeSession` 要求 `Scope`，因为返回的 session 内部可能持有 Claude query、Codex thread subscription、consumer fiber、Queue、PubSub、Deferred 和 SDK callback bridge。

Adapter 不负责跨 caller 的 create/resume single-flight，也不拥有长期 session 索引；这些属于 SessionService。Codex adapter 的 Layer 构造阶段也不得启动 app-server，见 §10.4。

### 6.2 HarnessAgentSession

为了兼容现有 Claude RPC，输入必须表达复合 message parts 和每 turn model：

```ts
export type UserInputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "inspector";
      readonly locations: ReadonlyArray<{
        readonly file: string;
        readonly line: number;
        readonly column: number;
      }>;
    };

export type UserInput = {
  readonly parts: ReadonlyArray<UserInputPart>;
  readonly model?: string;
};

export type PromptReceipt = {
  readonly turnId: string;
  readonly cursor: number;
  readonly started: boolean;
};
```

统一 session interface：

```ts
import type { Effect, Stream } from "effect";

export interface HarnessAgentSession {
  readonly id: string;
  readonly harnessAgentId: HarnessAgentId;

  /**
   * 预期的原生进程失败会先折成 session.crashed，再正常结束 stream。
   * E 通道不承载可恢复业务错误；未捕获 defect 仍由 fiber supervision 报告。
   */
  readonly events: Stream.Stream<SessionEnvelopeBody>;

  readonly prompt: (
    input: UserInput,
  ) => Effect.Effect<PromptReceipt, SessionClosed | TurnAlreadyRunning | AgentOperationError>;

  readonly interrupt: Effect.Effect<void, SessionClosed | AgentOperationError>;

  readonly respondToAgentRequest: (
    requestId: string,
    response: AgentResponse,
  ) => Effect.Effect<void, AgentRequestUnavailable | AgentOperationError>;

  readonly getCapabilities: Effect.Effect<
    SessionCapabilities,
    CapabilityUnsupported | AgentOperationError
  >;

  readonly close: Effect.Effect<void>;
}
```

`prompt` 只提交输入，不返回 turn 专属 AsyncGenerator；它返回 `{ turnId, cursor, started }` 作为调用与事件流的关联凭据。Claude 在接受输入时由 lifecycle 分配 turnId，Codex 使用 `turn/start` 返回的 id；steer 返回当前 active turnId，并以 `started: false` 表示本次提交没有创建新的 turn 事件流。所有结果统一从 `events` 返回。`close` 幂等：session 已关闭或索引中不存在时视为成功。

### 6.3 SessionCapabilities

新统一 contract 不直接暴露 `sdk.SlashCommand`、`sdk.ModelInfo` 和 `sdk.McpServerStatus`：

```ts
export interface SessionCapabilities {
  readonly commands: ReadonlyArray<AgentCommand> | undefined;
  readonly models: ReadonlyArray<AgentModel> | undefined;
  readonly mcpServers: ReadonlyArray<AgentMcpServerStatus> | undefined;
  readonly supportsResume: boolean;
  readonly supportsSteering: boolean;
  readonly supportsPermissions: boolean;
}
```

字段语义：

- `undefined`：adapter 不支持此能力；
- `[]`：支持，但当前没有数据。

统一 contract 只暴露 normalized capability DTO。Claude/Codex 原生 SDK 类型停留在 adapter 内部，不进入 RPC wire contract。

### 6.4 Registry

```ts
export class HarnessAgentRegistry extends Context.Service<
  HarnessAgentRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<AgentDescriptor>>;
    readonly get: (id: HarnessAgentId) => Effect.Effect<HarnessAgentAdapter, HarnessAgentNotFound>;
  }
>()("HarnessAgentRegistry") {}
```

Registry 用 `Layer.effect` 构造 adapter 集合。Layer 的构造 Effect 可以依赖 `Scope` 并注册最终 finalizer；当前 Effect v4 beta 不使用 `Layer.scoped` 这一名称。

Registry 构造必须是轻量的：

- 不启动 Codex app-server；
- 不打开 Claude session；
- 不因某个可选 adapter 不可用而使整个 Layer 构建失败；
- `checkAvailability` 才报告 executable/credential 状态。

### 6.5 SessionService 是唯一会话 ownership 模块

不单独公开 `HarnessAgentSessionManager`。它只有 SessionService 一个消费者，若把 `Scope.Closeable` 暴露在 manager interface 上，会使其他调用者绕过 session 生命周期不变量。

SessionService 内部状态：

```ts
type ManagedSession = {
  readonly session: HarnessAgentSession;
  readonly scope: Scope.Closeable;
  readonly pump: Fiber.Fiber<void>;
};

type SessionServiceState = {
  readonly active: HashMap.HashMap<string, ManagedSession>;
  readonly inFlight: HashMap.HashMap<string, Deferred.Deferred<ManagedSession, ResumeSessionError>>;
};
```

```ts
export class HarnessAgentSessionService extends Context.Service<
  HarnessAgentSessionService,
  {
    readonly create: (
      input: CreateSessionInput,
    ) => Effect.Effect<CreateSessionResult, CreateSessionError>;

    readonly resume: (input: {
      readonly sessionId: string;
      readonly harnessAgentId: HarnessAgentId;
    }) => Effect.Effect<void, ResumeSessionError>;

    readonly prompt: (
      sessionId: string,
      input: UserInput,
    ) => Effect.Effect<
      PromptReceipt,
      SessionNotFound | SessionClosed | TurnAlreadyRunning | AgentOperationError
    >;

    readonly interrupt: (
      sessionId: string,
    ) => Effect.Effect<void, SessionNotFound | SessionClosed | AgentOperationError>;

    readonly respondToAgentRequest: (
      sessionId: string,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<void, SessionNotFound | AgentRequestUnavailable | AgentOperationError>;

    readonly getCapabilities: (
      sessionId: string,
    ) => Effect.Effect<
      SessionCapabilities,
      SessionNotFound | CapabilityUnsupported | AgentOperationError
    >;

    readonly close: (sessionId: string) => Effect.Effect<void>;
  }
>()("HarnessAgentSessionService") {}
```

SessionService 自己由长期 service Scope 持有。它负责：

1. 用 `Scope.fork(serviceScope)` 创建 session child Scope；
2. 在 child Scope 中调用 adapter `openSession` / `resumeSession`；
3. 在 child Scope 中启动唯一的 event pump fiber；
4. 原子注册 `{ session, scope, pump }`；
5. 按 sessionId 管理 create/resume single-flight；
6. close 时排干事件、关闭 child Scope 并移除索引；
7. service Scope 关闭时兜底关闭所有 session。

### 6.6 Resume single-flight 与取消

Single-flight 必须在 SessionService，而不是 adapter 或某个 RPC caller 的 Scope 中。

```text
caller A ─┐
          ├── await shared Deferred ──► build fiber in service Scope
caller B ─┘                                  │
                                             └── owns child Scope
```

规则：

1. 第一个 caller 创建 Deferred，并用 `Effect.forkIn` 把构建 fiber 放进 service Scope；
2. 后续 caller 只等待同一个 Deferred；
3. caller 取消只停止自己的等待，不取消共享构建；
4. 构建失败必须关闭刚创建的 child Scope；
5. 原子注册发现已有 session 时，关闭新建 scope，并返回已存在实例；
6. Deferred 无论成功、失败还是 service shutdown 都必须完成；
7. in-flight entry 在所有终态中移除；
8. 即使所有 caller 都取消，共享构建仍完成并注册 session，以支持客户端重连；空闲 session 回收属于独立策略，不在本次实现中隐式取消。

Server 的 RPC procedure 只依赖 SessionService，不依赖具体 adapter 或内部 session map。

## 7. SessionLifecycle

每个活跃 session 有一个 `SessionLifecycle`，它是控制面事件的唯一出口。

### 7.1 状态

```ts
type LifecycleState = {
  readonly phase: "open" | "closing" | "closed" | "crashed";
  readonly activeTurnId: string | undefined;
  readonly pendingRequests: HashMap.HashMap<string, PendingRequestState>;
};
```

原生 approval params、response mapper 和 Deferred 保存在 `PendingRequestState`，不进入 wire `AgentRequest.native`。

### 7.2 不变量

1. 一个 turn 最多产生一次 `session.turn.started`。
2. 一个 turn 最多产生一次 `session.turn.ended`。
3. 一个 `session.request.asked` 必须由一次 `replied` 或 `rejected` 收尾。
4. resolve 后 request 从 pending map 移除；再次响应统一返回 `AgentRequestUnavailable`，不区分“从未存在”和“已处理”。
5. session 进入 `closed` / `crashed` 后不再接受新命令。
6. close/crash 时所有 pending request 自动 rejected，并完成对应 Deferred。
7. 不支持 steering 的 adapter 在 turn 活跃时收到 prompt，返回 `TurnAlreadyRunning`，不静默排队或覆盖。
8. 原生进程意外退出时先发 `session.crashed` 和必要的 request rejection，再结束 session output stream。

### 7.3 实现形态

状态转换保持纯函数，返回下一状态、要发布的事件和要完成的 request action；外层使用 `Ref.modify` 或 `SynchronizedRef.modifyEffect` 原子应用。

```ts
type LifecycleTransition =
  | {
      readonly ok: true;
      readonly state: LifecycleState;
      readonly events: ReadonlyArray<SessionEvent>;
      readonly actions: ReadonlyArray<PendingRequestAction>;
    }
  | { readonly ok: false; readonly error: LifecycleViolation };
```

Reducer 不直接操作 Queue、Deferred 或 EventBus，副作用由 session runtime 根据 transition 执行。调用者输入导致的合法拒绝映射到公开 tagged error；只有表示实现不变量被破坏的 `LifecycleViolation` 才转为 defect 并由 supervision 报告，不进入公开方法的 E 通道。

## 8. 统一事件流

当前 RPC 维护两类实时流：

- `prompt()` 返回 render chunks；
- `requestPermission()` 返回 Agent request。

Effect-native runtime 内部只保留一个 session output stream：

```text
Claude SDK / Codex app-server
           │
           ├── native message
           │      ├── transform() ───────── render chunk
           │      └── toSessionEvent() ──── control event
           │
           └── native approval request ──── session.request.asked
                                            │
                                            ▼
                               session output Queue
                                            │
                                            ▼
                              Stream<SessionEnvelopeBody>
                                            │ one consumer
                                            ▼
                         SessionService event pump Fiber
                                            │
                                            ▼
                                     EventBus publish
```

`SessionEnvelopeBody` 继续使用现有两平面模型：

- 不含 `.` 的 AI SDK chunk type 属于渲染面；
- 含 `.` 的 event type 属于控制面。

### 8.1 Pump ownership 和关闭顺序

SessionService 是 `session.events` 的唯一消费者。Pump fiber 在 session child Scope 中运行，并保存于 `ManagedSession`。Session output Queue 使用集中配置的 bounded capacity；原生 stream producer 可以通过 Queue backpressure 限速。只有 session runtime 的 close/crash 路径可以 end Queue，SessionService 只请求 close 并等待 pump，不能重复 end。

正常 close 顺序：

1. lifecycle 进入 closing，拒绝新 prompt/request response；
2. 自动 reject 所有 pending request，并把事件写入 session output Queue；
3. 停止原生输入并请求 query/thread 结束；
4. end session output Queue；
5. 等待 pump fiber 排干 Queue 并正常结束；
6. 关闭 session child Scope；
7. 从 active map 移除。

若排干超时，记录结构化日志后中断 pump，并继续关闭 Scope。不能先关 Scope 再期待尾部事件被发布。

预期的 process/SDK crash 不通过 `Stream` 的 `E` 通道传播：session 先发 `session.crashed`，完成 pending request rejection，然后正常结束 output stream。未捕获 defect 由 fiber supervision 和日志处理。

### 8.2 EventBus 背压

当前 `packages/server/src/events/event-bus.ts` 使用 `PubSub.unbounded`，不能直接承载所有 render delta。统一事件流接入前，EventBus 必须改为每订阅者有界缓冲：

- 控制事件和非 delta render chunk 不可静默丢弃；
- `*-delta` chunk 可以在订阅者过慢时丢弃；
- 发生 delta 丢弃时向该订阅者发 `gap` control，要求客户端重新拉 snapshot；
- 若不可丢弃事件到达时订阅者 Queue 已满，原子清空该订阅者 Queue，放入一个 terminal `gap`，随后结束该订阅；客户端必须重新订阅并拉 snapshot；
- terminal gap 使用独立状态/保留槽位，不能因为原 Queue 已满而丢失；
- 一个慢订阅者不得阻塞 publisher 或其他订阅者；
- buffer capacity 和 drop policy 由 EventBus 配置集中定义；
- 订阅取消时对应 Queue 必须由 Scope 自动 shutdown。

实现可以使用“共享 PubSub + 每订阅者有界 Queue”，也可以由 EventBus 直接管理 subscriber map；关键是 overflow 必须变成可观察的 terminal gap，而不是同时要求有界、不丢且不阻塞。

### 8.3 Snapshot 与 mid-turn gap 恢复

SessionService 在 event pump 中维护每个 session 的内存 projection：

- `cursor`：最后发布的 seq；
- `activeTurn.turnId`；
- 当前或最近刚结束 turn 的 render chunks；
- pending AgentRequests；
- lifecycle status。

`session.turn.started` 重置 active turn replay；render chunks 追加到 replay；`session.turn.ended` 后仍保留该 turn，直到下一次 turn started、session close，或后端冷历史确认已经包含该 turn。`getSnapshot` 合并后端冷历史和这份内存 replay，并通过 cursor 去重。

因此 mid-turn gap 不依赖尚未落盘的 Claude/Codex 历史，客户端可以立即用 snapshot 恢复。若 replay 因内部上限不可完整保留，snapshot 必须显式返回 degraded 状态，客户端等待 turn ended 后再拉冷历史，不能伪装成完整恢复。

### 8.4 统一 Session RPC

RPC 只暴露一个 provider-neutral `session` namespace：

- `create` / `resume`；
- `prompt` / `interrupt` / `close`；
- `events` / `snapshot` / `status` / `capabilities`；
- `respondToAgentRequest`。

客户端必须先建立 `session.events` 订阅，再调用 `session.prompt`。`prompt` 返回 `{ turnId, cursor, started }`，客户端按 `seq > cursor` 和目标 `turnId` 过滤事件。`started: false` 表示 steering 没有创建新 turn。

EventBus gap 恢复使用 subscribe-before-snapshot：先建立 replacement subscription，再读取 snapshot，回放 snapshot 中 `seq > lastCursor` 的 active-turn chunks，最后切换到 replacement stream 并忽略 `seq <= snapshot.cursor` 的重复帧。`degraded: true` 必须显式失败，不能伪装成完整恢复。

旧 `claudeCode` / `codex` RPC namespace、prompt-local stream 和 provider-specific permission routes已删除。

## 9. Claude Code runtime

### 9.1 当前问题

`claude-code/agent.ts` 当前使用：

- `Pushable<SDKUserMessage>`；
- `Pushable<ToolPermissionRequest>`；
- mutable session `Map`；
- `Map<string, Promise<SessionState>>` 做 resume single-flight；
- `Map<string, resolver>` 做权限等待；
- `AsyncGenerator<SDKMessage>` 做 prompt 输出；
- `throw Error` 表示 session/request 不存在。

### 9.2 输入

使用 `Queue<SDKUserMessage>` 代替 `Pushable`：

```ts
const inputQueue = yield * Queue.unbounded<sdk.SDKUserMessage>();
const inputStream = Stream.fromQueue(inputQueue);
const sdkInput = Stream.toAsyncIterable(inputStream);
```

`query()` 要求 `AsyncIterable`，因此 `Stream.toAsyncIterable` 是 Anthropic SDK 接缝处允许存在的桥接，不属于公共 runtime interface。

### 9.3 输出

SDK query 立即转为 Effect Stream：

```ts
const nativeMessages = Stream.fromAsyncIterable(query, (cause) => new ClaudeSdkError({ cause }));
```

每个 native message 只消费一次。当前 Effect v4 beta 使用 `Stream.flatMap` / `Stream.filterMap` 等实际存在的 API，不使用不存在的 `mapConcat` / `mapFilter`：

```ts
const output = Stream.flatMap(nativeMessages, (message) => {
  const chunks = Array.from(transform(message));
  const event = toSessionEvent(message, lifecycleView);
  return Stream.fromIterable(event ? [...chunks, event] : chunks);
});
```

若 lifecycle 转换需要 Effect 状态更新，则先 `mapEffect` 得到完整输出数组，再 `flatMap(Stream.fromIterable)`。

### 9.4 权限审批

Anthropic SDK 的 `canUseTool` 要求返回 Promise。内部逻辑仍由 Effect 管理：

1. 创建 `Deferred<PermissionResult, PermissionError>`；
2. 将 Deferred、原生请求上下文和 response mapper 放入 pending map；
3. 通过 lifecycle 发布 `session.request.asked`；
4. 等待 `Deferred.await`；
5. SDK abort、session close 或 Scope close 时以 deny 且 `interrupt: true` 完成；
6. session 构建时用 `Effect.runtime` 捕获受当前 Layer 管理的 Runtime；
7. 只在 SDK callback 接缝用该 Runtime 转成 Promise。

这里允许使用 `runPromise`，因为第三方 SDK 的反向 callback interface 只能返回 Promise。禁止使用模块全局 Runtime，也不得在 harness 公共 interface 或 server procedure 中调用 `runPromise`。

### 9.5 Resume ownership

Claude adapter 只负责执行一次原生 resume，不管理跨 caller single-flight。按 sessionId 的去重、构建 fiber、child Scope 和取消策略全部由 §6.6 的 SessionService 管理。

### 9.6 资源释放

Session 的显式 close 和 Scope finalizer 必须幂等，并完成：

1. 停止接收输入；
2. 以 deny + `interrupt: true` 完成所有 pending permission；
3. interrupt query；
4. end 原生输出并允许 event pump 排干；
5. shutdown Queue/PubSub；
6. 标记 lifecycle closed；
7. 清理 SDK callback 注册。

Pump fiber 的最终中断由 SessionService 在排干后关闭 child Scope 触发，session 自己不提前杀死 pump。

## 10. Codex runtime

### 10.1 CodexTransport interface

把 `codex/app-server.ts` 收敛成一个深模块：

```ts
export interface CodexTransport {
  readonly request: <A>(
    method: string,
    params?: unknown,
  ) => Effect.Effect<
    A,
    CodexTransportError | CodexRpcError | AgentProcessExited | AgentProtocolError
  >;

  readonly notifications: Stream.Stream<
    ServerNotification,
    CodexTransportError | AgentProcessExited | AgentProtocolError
  >;

  readonly serverRequests: Stream.Stream<
    ServerRequest,
    CodexTransportError | AgentProcessExited | AgentProtocolError
  >;

  readonly respond: (id: number, result: unknown) => Effect.Effect<void, CodexTransportError>;

  readonly shutdown: Effect.Effect<void>;
}
```

调用者不再了解：

- JSONL buffer；
- request id；
- pending map；
- stdout/stderr listener；
- process exit listener；
- stdin frame 格式；
- close timeout。

### 10.2 Request correlation

当前 `new Promise(resolve, reject)` 改为：

```ts
Ref<HashMap<RequestId, Deferred<unknown, CodexRpcError>>>;
```

发送 request：

1. 原子分配 request id；
2. 创建 Deferred；
3. 注册 pending；
4. 写入 stdin；
5. 等待 Deferred；
6. 在完成、失败、取消时移除 pending。

收到 response：

1. 按 id 原子取出并移除 Deferred；
2. result → `Deferred.succeed`；
3. error → `Deferred.fail(new CodexRpcError(...))`。

app-server 退出时，所有 pending Deferred 统一 fail 为 `AgentProcessExited`。

### 10.3 stdout/stderr bridge

Node child-process callback 保持在最窄接缝：

```text
stdout callback
      │
      ▼
Queue<InboundChunk>
      │
      ▼
scoped parser Fiber
      │
      ├── response → pending Deferred
      ├── notification → PubSub/Stream
      └── server request → PubSub/Stream
```

callback 不直接执行 session 业务逻辑。

stderr 保留固定大小 tail，用于构造 `AgentProcessExited`，但 tail 状态由 `Ref` 管理。

### 10.4 Lazy、可重启的子进程 ownership

Codex app-server 不能在 Registry/Adapter Layer 构造时启动。否则可选 adapter 不可用会拖垮整个 runtime，而且 Layer 中一次 acquire 的资源在 crash 后没有重建路径。

Codex adapter 持有：

```ts
type ManagedTransport = {
  readonly generation: number;
  readonly transport: CodexTransport;
  readonly scope: Scope.Closeable;
};

SynchronizedRef.SynchronizedRef<Option.Option<ManagedTransport>>;
```

Transport holder 使用显式状态机：

```ts
type TransportState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<ManagedTransport, CodexTransportError>;
    }
  | { readonly _tag: "Running"; readonly value: ManagedTransport };
```

`ensureTransport`：

1. 用 `SynchronizedRef` 只做 Idle/Starting/Running 的原子状态转换；
2. 第一个 caller 将状态改为 Starting，并用 `Effect.forkIn` 把 spawn+initialize fiber 放进 adapter 长期 Scope；
3. 其他 caller 只等待 Starting 中共享的 Deferred；
4. caller 取消只停止自己的等待，不中断共享构建；
5. 构建 fiber 从 adapter Scope `Scope.fork` 出 transport child Scope，并在其中运行 `makeCodexTransport`；
6. 成功后原子改为 Running，并完成 Deferred；
7. 失败或 adapter shutdown 时关闭 child Scope、恢复 Idle，并完成 Deferred；
8. 不得在首个 caller 的 `SynchronizedRef.modifyEffect` fiber 内直接执行 spawn。

Transport child Scope 中优先使用 Effect v4 的 process service：

```ts
const spawner = yield * ChildProcessSpawner.ChildProcessSpawner;
const child =
  yield *
  spawner.spawn(
    ChildProcess.make(command, args, {
      cwd,
      env,
      forceKillAfter: "2 seconds",
    }),
  );
```

`ChildProcessHandle` 的 stdin/stdout/stderr/exitCode 直接接入 Stream/Sink/Effect，child Scope 关闭时由 platform finalizer 终止进程。实现前必须在 beta.97 spike 中验证 `@effect/platform-node/NodeServices` 的提供方式。若该 API 缺少当前 transport 所需能力，才回退到 `Effect.acquireRelease(spawnAndInitialize, shutdown)`，并记录原因。

意外退出：

1. fail 所有 transport pending Deferred；
2. 每个 Codex session 都绑定创建它的 transport generation，并订阅该 transport 的 exit signal；exit 时各 session 自行发出 `session.crashed` 并结束，不由 adapter 维护第二份 session 索引；
3. 仅当 generation 仍匹配时清空 Ref，避免旧进程退出覆盖新实例；
4. 关闭旧 transport Scope；
5. 下一次 create/resume/capability 操作重新调用 `ensureTransport`，完成 lazy restart。

`shutdown`：

1. 标记 transport closing；
2. 停止接收新 request；
3. fail 所有 pending Deferred；
4. 请求进程正常退出；
5. 依赖 `forceKillAfter` 或 Effect Clock 等待退出；
6. 超时后 SIGKILL；
7. raw Node fallback 才需要显式移除 process listener；
8. shutdown queues/pubsubs。

可以保留同步 `process.once("exit", kill)` 作为最后一道 zombie net，但 Scope finalizer 是正常释放路径。Adapter 的长期 Scope 关闭时，对当前 Ref 中的 transport 做最终兜底关闭。

### 10.5 Protocol validation

不为全部生成 protocol 类型建立 Schema。只在 JSONL 接缝验证最小 frame：

```ts
type RpcFrame =
  | { id: number; result: unknown }
  | { id: number; error: RpcErrorBody }
  | { id?: number; method: string; params?: unknown };
```

通过最小 frame Schema 后，再根据 version-matched generated protocol 做窄断言。非 JSON 行和非法 frame 进入明确的 `AgentProtocolError`，不能静默吞掉。

## 11. Effect Schema 与 Standard Schema 互操作

Standard Schema 是 Zod、Effect Schema、oRPC 和 AI SDK 之间的正式 seam。公共 contract 不依赖“这是 Zod schema”或“这是 Effect Schema”，只依赖 Standard Schema。

当前版本已确认：

- Zod 4 原生实现 `StandardSchemaV1`；
- `effect@4.0.0-beta.97` 提供 `Schema.toStandardSchemaV1` 和 `Schema.toStandardJSONSchemaV1`；
- `@orpc/contract@2.0.0-beta.16` 的 `AnySchema` 就是 `StandardSchemaV1`；
- `@orpc/experimental-effect@2.0.0-beta.16` 原生导出 `toStandardSchema(effectSchema)`，并提供 `EffectSchemaToJsonSchemaConverter`；
- AI SDK 7 的 tool schema 接受 Standard Schema，并在生成传给 provider 的 JSON Schema 时读取 Standard JSON Schema extension。

因此 oRPC 对 Effect Schema 有官方集成，但不是把原始 `Schema.Struct(...)` 直接传给 `oc.input`：仍需通过官方 `toStandardSchema` 或等价的 Standard Schema view。迁移可以逐 procedure 进行，旧 Zod schema 和 Effect-derived Standard Schema 可以同时存在于同一个 oRPC router。

### 11.1 Effect Schema 作为新定义的 source of truth

以下新定义或被 Agent runtime 修改的定义优先使用 Effect Schema：

- `HarnessAgentId`；
- `AgentRequest` / `AgentResponse`；
- `AgentRequestAction` / `AgentRequestQuestion`；
- `TokenUsage` / `TurnError`；
- session/global control event；
- session/capability DTO；
- envelope 中可以运行时验证的控制面数据；
- 需要跨 RPC 序列化的 tagged error data。

类型从 Effect Schema 派生：

```ts
export const HarnessAgentIdSchema = Schema.Literals(["claude-code", "codex"]);

export type HarnessAgentId = typeof HarnessAgentIdSchema.Type;
```

内部 Effect runtime 使用原始 Effect Schema；所有外部消费者统一使用一个名为 `toStandardSchema` 的转换，不按 oRPC/AI SDK 分别命名 helper：

```ts
export const toStandardSchema = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
  Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
```

返回值同时保留原 Effect Schema，并在同一个 `~standard` capability 上提供：

- `validate`：供 oRPC 和通用 Standard Schema consumer 使用；
- `jsonSchema.input/output`：供 AI SDK 和 JSON Schema/OpenAPI consumer 使用。

```ts
export const HarnessAgentIdStandardSchema = toStandardSchema(HarnessAgentIdSchema);
```

`packages/contract` 不依赖 harness 或 server；它持有共享 wire DTO、Effect Schema 和 `toStandardSchema`。`packages/harness` 依赖 contract，并仅为旧 import path 提供兼容性 re-export。浏览器运行时使用纯 `@vibest/contract/session-events` 子路径读取事件 guard，避免把 Effect Schema runtime 打入 app bundle。

禁止在 Zod 和 Effect Schema 之间手工互转 AST 或维护两份同义 schema。

### 11.2 AI SDK 直接消费完整 Standard Schema view

```ts
const BashInputSchema = Schema.Struct({
  command: Schema.String,
});

export const Bash = tool({
  inputSchema: toStandardSchema(BashInputSchema),
});
```

不引入 `toAiSdkSchema` 之类的 consumer-specific 命名。手写 legacy tool schema 使用真实 `Schema.Struct`。SDK 生成、当前由 `z.custom<T>()` 无验证透传的类型，可以使用声明型 Effect Schema，但必须明确它是 trusted opaque value，不得宣称做了 runtime validation。

### 11.3 增量迁移和 bundle gate

Standard Schema 解决兼容性，但不自动解决浏览器 bundle 成本。执行 Schema 迁移前必须做一个小型 spike：

1. 在一个 oRPC input、一个 event iterator yield schema 和一个 AI SDK tool 上分别验证 Effect-derived Standard Schema；
2. 验证 Zod schema 与 Effect-derived schema 可以在同一 contract/router 中共存；
3. 比较 `apps/app` production bundle 在迁移前后的 Effect/Zod chunk；
4. 将 Effect 版本放入 pnpm catalog，并让 harness/server/contract 精确使用同一版本，避免 beta 双实例；
5. 若 bundle 成本不可接受，browser-facing contract 暂时保留 Zod 实现，但仍以 Standard Schema 作为消费者 interface；不得因此阻塞 runtime Effect 化。

删除 `packages/harness` 的 Zod 依赖是长期清理目标，不是 Agent runtime 迁移的前置条件。是否删除由上述 spike 和全部 tool schema 迁移结果决定。

### 11.4 native 字段

当前 `AgentRequest` / `AgentResponse` 中的 `native: unknown` 不利于 Standard Schema wire validation，也可能携带非 JSON 数据。

目标设计：

- 原生 request params、approval source 和 Deferred 仅保存在 server-side pending map；
- 客户端只收到归一化 AgentRequest；
- 客户端返回 `behavior` 或 `actionId`；
- session 根据 `requestId` 找到原生上下文并生成原生响应。

若迁移期必须保留扩展数据，字段必须约束为 JSON-safe value，而不是任意 `unknown`。

## 12. 错误模型

新增 `packages/harness/src/runtime/errors.ts`。

具体 tagged errors：

| Error                     | 条件                                     |
| ------------------------- | ---------------------------------------- |
| `HarnessAgentNotFound`    | 未注册对应 adapter                       |
| `AgentUnavailable`        | 凭证或运行环境不可用                     |
| `ExecutableNotFound`      | Claude/Codex executable 无法解析         |
| `AgentOpenError`          | 创建原生 session/thread 失败             |
| `SessionNotFound`         | 活跃 session 不存在                      |
| `SessionNotResumable`     | 后端没有可恢复历史                       |
| `SessionClosed`           | 对已关闭 session 执行操作                |
| `TurnAlreadyRunning`      | 不支持 steering 时并发 prompt            |
| `AgentRequestUnavailable` | requestId 不存在或已被处理               |
| `AgentOperationError`     | 已打开 session 的原生操作失败            |
| `ClaudeSdkError`          | Anthropic SDK 接缝失败                   |
| `CodexTransportError`     | stdio、写入或 transport 状态失败         |
| `CodexRpcError`           | app-server 返回 RPC error                |
| `AgentProcessExited`      | 子进程意外退出                           |
| `AgentProtocolError`      | 收到非法协议 frame                       |
| `CapabilityUnsupported`   | adapter 不支持所请求能力                 |
| `LifecycleViolation`      | session lifecycle 非法转换；属于内部错误 |

方法签名中的聚合错误使用 type alias，不再发明未定义的 error class：

```ts
type CreateSessionError =
  HarnessAgentNotFound | AgentUnavailable | ExecutableNotFound | AgentOpenError;

type ResumeSessionError =
  SessionNotFound | SessionNotResumable | AgentUnavailable | ExecutableNotFound | AgentOpenError;
```

Runtime 第一阶段使用 `Data.TaggedError`。需要跨 RPC 暴露的 error data 在 §11 Standard Schema spike 通过后使用当前 Effect v4 的 `Schema.TaggedErrorClass`，并通过 oRPC error map 显式映射。

禁止继续使用：

```ts
throw new Error("session not found");
promise.catch(() => {});
```

需要忽略的失败必须显式说明策略并记录日志，例如“session close 时 unsubscribe 失败不覆盖原始 close 结果”。

## 13. Server 接入

### 13.1 RPC procedure

当前：

```ts
const codex = yield * Codex;
return yield * Effect.promise(() => codex.session.create(input));
```

目标：

```ts
const sessions = yield * HarnessAgentSessionService;
return yield * sessions.create(input);
```

`packages/server/src/rpc/claude-code.ts` 和 `codex.ts` 不再声明只包装普通 Agent class 的 `ClaudeCode` / `Codex` service。

### 13.2 Root Layer

```ts
export const HarnessRuntimeLayer = Layer.mergeAll(
  HarnessAgentRegistryLayer,
  HarnessAgentSessionServiceLayer,
  ClaudeCodeAdapterLayer,
  CodexAdapterLayer,
);
```

SessionService 内部持有 session map、single-flight、child scopes 和 pump fibers，不再有独立 SessionManager Layer。CodexAdapterLayer 只构造 lazy transport holder，不启动 app-server。

当前 Effect v4 beta 使用 `Layer.effect` 承载需要 Scope 的构造 Effect；不要使用不存在的 `Layer.scoped` 名称。

### 13.3 Runtime ownership

`packages/server/src/rpc/handlers.ts` 当前创建模块全局 `ManagedRuntime`，并用 `runtime.runSync(runtime.contextEffect)` 同步提取 context。引入异步/scoped Layer 后，这个模式必须删除。

目标 factory：

```ts
type RpcRuntime = {
  readonly context: RpcContext;
  readonly createNodeHandler: () => NodeHandler;
  readonly createWsHandler: () => WsHandler;
  readonly dispose: () => Promise<void>;
};

async function createRpcRuntime(): Promise<RpcRuntime>;
```

Ownership：

```text
createServer()
  ├── await createRpcRuntime()
  ├── create HTTP / WS handlers from runtime
  └── server close
        ├── stop accepting HTTP / WS work
        ├── close active transports
        └── await runtime.dispose()
```

改造范围明确包括：

- `packages/server/src/rpc/handlers.ts`；
- `packages/vibest/src/node/server.ts`；
- dev WebSocket handler `teardown`；
- Electron backend shutdown；
- CLI SIGINT/SIGTERM shutdown。

`dispose` 必须幂等。Handler factory 不得在模块加载时创建长期资源，caller 必须显式拥有 runtime。

## 14. 测试策略

新 Effect runtime 测试使用与 `effect` 完全同版本的 `@effect/vitest`，优先 `it.effect` / `it.layer`；需要 Scope 的测试必须在 scoped test 中运行。除专门验证 Promise 接缝外，不在新测试中调用 `Effect.runPromise`、`Effect.runSync` 或创建 `ManagedRuntime`。测试通过 Layer 注入 fake SDK/transport，不直接 mock Agent service 的内部状态。Schema decoder/encoder compiler 提升到模块级。

### 14.1 Claude tests

必须覆盖：

- create 使用指定 session id；
- resume 成功；
- 不可恢复返回 `SessionNotResumable`；
- SessionService 并发 resume 只调用一次 adapter；
- 一个等待 caller 被取消不影响共享 resume 构建；
- 构建失败会关闭 child Scope 并完成所有 waiter；
- prompt 的复合 parts 和 per-turn model 保持兼容；
- query 输出转成 render/control 两平面；
- permission allow/deny；
- permission abort；
- close 时 pending permission 以 `interrupt: true` 自动 deny；
- Scope close 会 interrupt query；
- 重复 close 幂等。

### 14.2 CodexTransport tests

必须覆盖：

- adapter Layer 构造不会启动 app-server；
- 第一次使用时 lazy initialize；
- 并发第一次使用只启动一个进程；
- request/response correlation；
- RPC error → typed `CodexRpcError`；
- notification stream；
- server request stream；
- 非法 JSON/非法 frame；
- 进程中途退出；
- 退出时所有 pending Deferred fail；
- crash 清空对应 generation，下一次操作重启 app-server；
- 旧 generation 退出不会清除新 transport；
- shutdown 正常退出；
- `ChildProcessSpawner` 的 NodeServices 集成；
- shutdown timeout 后 SIGKILL；
- Scope close 后没有遗留进程和 listener。

### 14.3 SessionLifecycle tests

使用纯 reducer 表驱动测试：

- started → ended；
- ended without started；
- duplicate ended；
- request asked → replied；
- request asked → rejected；
- duplicate reply → `AgentRequestUnavailable`；
- close rejects all pending；
- crashed 先发 crash/rejection 再结束；
- closed 后 emit；
- busy session 的 prompt/steer 决策。

### 14.4 Event 和 integration tests

- event pump 在 child Scope 中运行并排干尾部事件；
- façade 先订阅再 prompt，不丢 `start` / `turn.started`；
- façade 只返回对应 turn 的 chunk；
- 慢订阅者不会造成无界增长；
- delta 丢弃会产生 gap，控制事件不静默丢失；
- 通过 HarnessAgentSessionService 驱动 fake Claude/Codex adapter；
- 通过 oRPC router 创建 session 并订阅事件；
- 旧 prompt 的 model、复合 parts 和返回 chunk 行为兼容；
- 旧 capability RPC 保持原生 SDK wire shape；
- Standard Schema spike 同时覆盖 Zod、Effect-derived schema、oRPC iterator 和 AI SDK tool；
- runtime dispose 后 fake child process 收到终止；
- server close 会触发 runtime dispose。

禁止用固定 sleep 等待异步结果；使用 Deferred、TestClock、stream collection、event-pump barrier 或 `vi.waitFor`。

## 15. 迁移计划

### Phase 0：行为基线

先补 characterization tests，不修改公开接口。

完成条件：

- Claude create/resume、model、复合 message parts 和 capability wire shape 被测试钉住；
- Codex lazy start、request correlation、turn/steer、crash 后重启被测试钉住；
- pending approval、close 和 server shutdown 行为有明确测试。

### Phase 1：Effect 基础和 typed errors

1. 把 Effect 版本放入 pnpm catalog，harness/server/contract 精确使用同一版本。
2. `packages/harness` 引入 Effect。
3. 新增 §12 的 runtime tagged errors。
4. 建立 Effect-aware test helpers 和 scoped test style。
5. 不修改 wire Schema。

### Phase 2：CodexTransport

优先改 Codex，因为资源和并发风险最大：

1. `Effect.acquireRelease` 管理单个 transport；
2. stdin/stdout Queue；
3. pending Deferred；
4. notification/server-request Stream；
5. process crash propagation；
6. shutdown finalizer；
7. adapter 内 lazy、single-flight、generation-safe restart holder；
8. 基于 Effect Clock 的 close timeout。

完成条件：Layer 构造不启动 Codex，首次使用启动一次，crash 后下一次操作可以重启。

### Phase 3：Claude runtime

1. SDK query 输入改 Queue；
2. query 输出改 Stream；
3. permission 改 Deferred；
4. query 和 callback bridge 纳入 session Scope；
5. 保留 model 和复合 message parts；
6. adapter 不再管理 resume single-flight；
7. 去除 runtime 内的 Promise resolver 和自制 Pushable。

### Phase 4：Registry + 深 SessionService

加入并接通：

- `HarnessAgentAdapter`；
- `HarnessAgentSession`；
- `HarnessAgentRegistry`；
- 内含 active map/single-flight/child scopes/pump 的 `HarnessAgentSessionService`；
- `SessionLifecycle`。

同时完成：

- service-scope resume single-flight；
- caller cancellation isolation；
- session event pump；
- close 排干和幂等；
- Codex/Claude 统一 interface。

### Phase 5：EventBus 与 Server runtime ownership

1. EventBus 改为每订阅者有界缓冲和 gap 策略；
2. RPC 直接依赖 `HarnessAgentSessionService`；
3. 删除 server 中仅包装普通对象的 `ClaudeCode` / `Codex` service；
4. 建立“先订阅、后 prompt”的统一 Session RPC；
5. `createRpcRuntime` 改为显式异步 factory；
6. dispose 接入 `packages/vibest`、dev WS、Electron backend 和 CLI shutdown；
7. 增加 server integration tests。

### Phase 6：客户端统一订阅和兼容清理

1. 客户端切到统一 session subscription；
2. 删除旧 prompt/requestPermission 分流；
3. 删除旧 Claude capability 原生兼容接口；
4. 删除 Promise-based Agent/Session class；
5. 删除 Agent RPC 中的 `Effect.promise`；
6. 删除旧 runtime export。

### Phase 7：Standard Schema 增量迁移

1. 完成 §11.3 的 oRPC/AI SDK/bundle spike；
2. 新 Agent schema 使用 Effect Schema 作为 source of truth；
3. 通过 Standard Schema view 接入 oRPC；
4. AI SDK tool 同时提供 Standard Schema 和 Standard JSON Schema；
5. 逐 procedure 与现有 Zod schema 共存迁移；
6. 根据 bundle 和迁移结果决定是否删除 harness 的 Zod 依赖。

该阶段可以和 runtime 后期工作并行，但不是 Phase 2–5 的前置条件。

## 16. 验收标准

改造完成必须同时满足：

1. Agent runtime 公开 interface 只返回 `Effect` 或 `Stream`。
2. `Promise` / `AsyncIterable` 只存在于 Anthropic SDK、Node child process、AI SDK 和 oRPC 等外部接缝。
3. `packages/harness/src/utils/pushable.ts` 已删除。
4. pending 操作使用 `Deferred`，共享状态使用 `Ref` / `SynchronizedRef`。
5. SessionService 独占 active session、single-flight、child Scope 和 event pump ownership。
6. Codex app-server lazy start，意外退出后下一次操作可重启。
7. Claude query、Codex transport 和 session fibers 全部受 Scope 管理。
8. runtime dispose 后无子进程、无 pending Deferred、无遗留 process listener。
9. 所有预期错误都在 Effect 的 `E` 通道中。
10. Server Agent RPC 中没有 `Effect.promise` 包装 harness 方法。
11. Claude/Codex 通过统一 adapter/session interface。
12. `transform` / `toSessionEvent` 等纯逻辑保持纯函数。
13. 统一 RPC 保持 per-turn model、复合 parts、normalized capabilities 和 stream chunk 行为。
14. EventBus 对慢订阅者有界，delta drop 会触发 gap recovery。
15. 取消、崩溃、并发 resume、pending approval、pump 排干均有回归测试。
16. Effect Schema 经 Standard Schema 接入 oRPC；Zod 与 Effect-derived schema 可增量共存。
17. 以下命令全部通过：

```bash
pnpm --filter @vibest/harness test
pnpm --filter @vibest/harness typecheck
pnpm --filter @vibest/server test
pnpm --filter @vibest/server typecheck
pnpm --filter @vibest/contract typecheck
pnpm --filter @vibest/app typecheck
```

## 17. 实施优先级

权威顺序与 §15 一致：

```text
Behavior baseline
      │
      ▼
Typed errors + Effect foundation
      │
      ▼
CodexTransport lazy/restart runtime
      │
      ▼
Claude Queue/Stream/Deferred runtime
      │
      ▼
Registry + deep SessionService
      │
      ▼
Bounded EventBus + Server ownership
      │
      ▼
Client unified subscription
      │
      ▼
Standard Schema incremental migration
```

最高风险区域：

1. Codex lazy process ownership 和 crash restart；
2. resume single-flight 的 service Scope 与 caller cancellation 隔离；
3. event pump 的订阅时序和关闭排干；
4. pending request 生命周期；
5. EventBus 慢订阅者背压；
6. server shutdown 时 runtime dispose。

目录和 Schema 清理在这些 ownership 问题解决后进行。Standard Schema 是 Zod、Effect Schema、oRPC 和 AI SDK 的统一 interface，不做 Zod/Effect AST 级互转。
