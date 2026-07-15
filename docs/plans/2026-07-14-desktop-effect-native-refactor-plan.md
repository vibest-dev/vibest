# Desktop Effect Native + oRPC Refactor Plan

- **Base:** `origin/main@c866383`
- **Date:** 2026-07-14
- **Scope:** `apps/desktop`
- **Status:** Implemented

> 远端默认分支实际是 `main`，不是 `master`。实现基于 `origin/main@c866383`，位于 `feat/desktop-effect-native`。
>
> Phase 0 曾验证 custom-protocol Fetch 可用于 unary oRPC，但 Fetch EventIterator cancellation 不能可靠执行 server finalizer，因此中间实现使用过 bounded long-polling。最终实现改用 oRPC 原生 MessagePort adapter；stream cancellation gate 已通过，backend 状态使用 AsyncIterator，custom protocol 只负责 Renderer 静态资源。
>
> 实现完成后，Main 按单向依赖重新组织为 application、backend、RPC 和 Electron adapter 模块。最终目录介绍见 `apps/desktop/src/main/README.md`，依赖规则和实现原则见 `apps/desktop/AGENTS.md`；下文中的旧文件名保留为迁移过程记录。
>
> 打包应用启动时会读取完整的 login-shell 导出环境并传给 backend；Claude Agent SDK `query()` 也显式接收该环境，确保 GUI 启动时代理变量不会丢失。

## 1. 目标

把 Electron desktop shell 改成下面的结构：

1. Electron main 中的 backend 子进程、重启、状态、超时和释放由 Effect 管理。
2. Renderer/Main 通信完全移除 Electron IPC。
3. Renderer/Main 使用 oRPC Fetch transport，通过现有 `vibest://app` custom protocol 通信。
4. oRPC procedure 内部使用 Effect service、Layer、Scope、Stream 和 typed error。
5. 保留 Renderer 到 CLI backend 的现有 loopback HTTP/WebSocket oRPC 通信。
6. 不把 React Renderer 改造成 Effect 应用。

最终存在两个明确、互不混合的 RPC 平面：

```text
Renderer
  │
  ├── Desktop Shell RPC
  │     vibest://app/api/desktop-rpc
  │     Renderer ↔ Electron Main
  │     bootstrap / backend status / retry / quit
  │
  └── Backend RPC
        http://127.0.0.1:<port>/api/rpc
        ws://127.0.0.1:<port>/ws/rpc
        Renderer ↔ @vibest/cli child process
        Claude Code / Codex / domain operations
```

## 2. `origin/main@c866383` 的新基线

与上一版方案相比，远端 `main` 已经包含以下事实。

### 2.1 Desktop supervision 已进入 main

当前 `apps/desktop/src/main` 已经有：

- `backend.ts`：CLI 子进程启动和 ready handshake；
- `supervisor.ts`：固定 token、固定 port、自动重启、退避和 failed 状态；
- `index.ts`：IPC bootstrap、status push、retry、quit；
- Renderer reconnecting/failed overlay；
- Claude session 在 backend 重启后的 resume 支持。

新方案不是重新设计 supervision 行为，而是把现有行为迁入 Effect，并替换通信 seam。

### 2.2 Backend RPC 已扩展为 Claude Code + Codex

`packages/server/src/rpc` 现在包含：

```text
rpc/context.ts
rpc/claude-code.ts
rpc/codex.ts
rpc/router.ts
rpc/handlers.ts
```

`RpcContext` 已独立为：

```ts
WithEffectContext<ClaudeCode | Codex>;
```

Desktop main 的 RPC 组织方式应参考这个模式：

- 独立 `context.ts`；
- contract-first；
- `.effect` procedure；
- 一个 runtime context 供所有 transport 使用。

但 Desktop Shell RPC 不加入 `packages/server` router，也不加入现有 backend contract。它控制 Electron shell，不属于 CLI backend。

### 2.3 Session recovery 不是 provider-neutral

当前 Claude Code session 可以在 backend 重启后 resume；Codex session 仍保存在 backend 进程内存中，backend 重启后会丢失。

因此新方案不能继续泛化地宣称：

> backend 重启后所有 agent session 都会透明恢复。

Desktop status overlay 应使用 provider-neutral 文案，例如：

```text
The local server restarted. Reconnecting…
```

不要承诺 `Restoring your session`，除非 Codex 也实现了恢复。

Codex session recovery 属于独立后续工作，不混入本次 desktop main refactor。

## 3. 已确定的架构决策

### 3.1 使用 oRPC + Effect

采用：

```text
oRPC：contract、transport、serialization、typed client、bounded long-polling
Effect：service、Layer、Scope、Stream、state、concurrency、typed error
```

暂不采用 `effect/unstable/rpc`，原因：

- 当前 Effect 是 `4.0.0-beta.97`；
- Effect RPC 仍位于 `effect/unstable/rpc`；
- Renderer 当前使用 Promise、AsyncIterator、TanStack Query，不使用 Effect Runtime；
- 项目已经全面采用 oRPC；
- Electron `protocol.handle` 原生接受 Fetch `Request` 并返回 `Response`，与 `@orpc/server/fetch` 直接匹配；
- 引入 Effect RPC 会形成第二套 contract、client、stream 和 error 约定。

### 3.2 不使用 Electron IPC 或 MessagePort

最终代码中删除：

- `ipcMain`；
- `ipcRenderer`；
- `contextBridge`；
- `window.vibest`；
- preload build；
- `apps/desktop/src/preload/`；
- `apps/desktop/src/shared/bridge.ts`。

虽然 oRPC 有 MessagePort adapter，但 Electron main 向 Renderer 传递 MessagePort 仍需要 Electron messaging API，因此不符合要求。

### 3.3 Desktop RPC 不开放 TCP 端口

首选 endpoint：

```text
vibest://app/api/desktop-rpc
```

优点：

- 地址稳定；
- 无额外端口发现；
- 不增加 loopback listener；
- production 下与 renderer 同源；
- 不需要 Desktop Shell bearer token；
- 可以复用现有 protocol handler。

### 3.4 Backend RPC 保持不变

Renderer 仍然通过 bootstrap 得到：

```ts
{
  httpBaseUrl,
  wsBaseUrl,
  token,
}
```

然后继续使用：

- `createVibestClient`；
- `createVibestWsClient`；
- backend bearer token；
- WebSocket single-use ticket。

Desktop Shell RPC 不能代理 backend HTTP/WebSocket，也不能把两个 router 合并成一个。

## 4. 目标架构

```text
┌──────────────────────────────────────────────────────────────┐
│ Desktop Renderer                                             │
│                                                              │
│  desktop-client.ts                                           │
│      │                                                       │
│      ├── desktop.bootstrap                                   │
│      ├── desktop.status.watch                                │
│      ├── desktop.backend.retry                               │
│      └── desktop.app.quit                                    │
└──────┼───────────────────────────────────────────────────────┘
       │ oRPC Fetch
       ▼
┌──────────────────────────────────────────────────────────────┐
│ vibest://app protocol                                        │
│                                                              │
│  /api/desktop-rpc/* ──► Desktop RPC FetchHandler             │
│  other paths          ──► renderer asset / SPA fallback      │
└──────┬───────────────────────────────────────────────────────┘
       │ WithEffectContext
       ▼
┌──────────────────────────────────────────────────────────────┐
│ DesktopMainLayer                                             │
│                                                              │
│  BackendSupervisor                                           │
│      ├── BackendProcess                                      │
│      ├── LoginShellPath                                      │
│      ├── SubscriptionRef<BackendStatus>                      │
│      ├── retry Queue                                         │
│      └── supervisor Fiber                                    │
│                                                              │
│  DesktopLifecycle                                            │
│      └── requestQuit                                         │
│                                                              │
│  WindowManager                                               │
│      ├── ensureOpen                                          │
│      └── focus                                               │
│                                                              │
│  AppProtocol                                                 │
│      ├── oRPC dispatch                                       │
│      └── static renderer dispatch                            │
└──────┬───────────────────────────────────────────────────────┘
       │
       ▼
┌──────────────────────────────────────────────────────────────┐
│ @vibest/cli child process                                    │
│                                                              │
│  ClaudeCode | Codex backend RPC                              │
└──────────────────────────────────────────────────────────────┘
```

## 5. State 和资源所有权

| State / resource      | Owner                              | Mutation path                 | Release path               |
| --------------------- | ---------------------------------- | ----------------------------- | -------------------------- |
| backend token         | `BackendSupervisor` Layer          | startup only                  | runtime memory release     |
| pinned backend port   | `BackendSupervisor`                | first ready only              | runtime release            |
| backend status        | `SubscriptionRef`                  | supervisor Fiber              | runtime release            |
| fast-failure count    | supervisor Fiber local state       | crash/retry                   | Fiber interruption         |
| retry request         | bounded Queue                      | Desktop RPC `retry`           | runtime release            |
| current CLI process   | per-cycle Scope                    | supervisor Fiber              | exit or Scope interruption |
| stdout/stderr readers | child Fibers                       | process streams               | process Scope close        |
| main BrowserWindow    | `WindowManager`                    | ensure/closed                 | WindowManager finalizer    |
| desktop RPC handler   | `AppProtocol`                      | Layer acquisition             | `protocol.unhandle`        |
| status long poll      | request scope                      | revision change / 20s timeout | request completion/abort   |
| renderer status       | existing `Platform.status` adapter | bootstrap + polling           | React unsubscribe          |

禁止出现以下重复状态：

- main 中一份 status；
- preload 中一份 status；
- renderer Zustand 中再复制一份 status。

Renderer 只保存用于显示的 React local state；source of truth 始终是 `BackendSupervisor`。

## 6. Effect 依赖和版本

Desktop 与 server 保持同一 Effect 版本：

```json
{
  "effect": "4.0.0-beta.97",
  "@effect/platform-node": "4.0.0-beta.97",
  "@orpc/experimental-effect": "2.0.0-beta.16",
  "@orpc/server": "2.0.0-beta.16"
}
```

现有 Renderer dependencies 继续使用：

```json
{
  "@orpc/client": "^2.0.0-beta.16",
  "@orpc/contract": "^2.0.0-beta.16"
}
```

`@effect/platform-node` 必须显式使用 Effect 4 beta 对应版本；不能安装当前面向 Effect 3 的普通 latest。

优先使用 targeted Node layers：

- `NodeChildProcessSpawner.layer`；
- `NodeFileSystem.layer`；
- `NodePath.layer`。

不要仅为了 child process 引入与任务无关的 Node services。

## 7. Module 设计

## 7.1 `BackendProcess`

**Purpose:** 管理一次 CLI backend process 的完整生命周期。

建议继续使用当前文件：

```text
apps/desktop/src/main/backend.ts
```

### Interface

```ts
export class BackendProcess extends Context.Service<
  BackendProcess,
  {
    readonly launch: (
      port: number,
    ) => Effect.Effect<
      RunningBackendProcess,
      BackendSpawnError | BackendReadyTimeout | BackendExitedBeforeReady,
      Scope.Scope
    >;
  }
>()("desktop/BackendProcess") {}

export type RunningBackendProcess = {
  readonly boundPort: number;
  readonly awaitExit: Effect.Effect<BackendProcessExit>;
};
```

### Hidden implementation

调用方不能知道：

- Node `ChildProcess`；
- EventEmitter listener；
- stdout readline；
- timer handle；
- `kill()`；
- ready Deferred。

### Launch command

保留当前语义：

```ts
ChildProcess.make(process.execPath, [entry], {
  env: {
    ...process.env,
    ...(shellPath ? { PATH: shellPath } : {}),
    ELECTRON_RUN_AS_NODE: "1",
    VIBEST_AUTH_TOKEN: token,
    VIBEST_PORT: String(port),
    VIBEST_CORS_ORIGINS: corsOrigins.join(","),
  },
});
```

### Ready handshake

用以下 primitives 替换手写 Promise：

```text
Deferred<number, BackendStartError>
Effect.timeout
Stream.decodeText
Stream.splitLines
Effect.forkScoped
```

运行三个 scoped Fibers：

1. stdout reader；
2. stderr logger；
3. process exit watcher。

stdout reader 在读到 ready line 后仍必须继续消费 stdout，避免 pipe backpressure。

```text
stdout line
  ├── parseReadyLine = null → Effect.logInfo
  └── ready                → Deferred.succeed(port)
```

process 在 ready 前退出时：

```ts
BackendExitedBeforeReady;
```

30 秒未 ready 时：

```ts
BackendReadyTimeout;
```

Scope 关闭时由 Effect process adapter 终止 child，不再由调用方执行 `stop()`。

## 7.2 `LoginShellPath`

继续保留当前行为：

- Windows 不探测；
- `$SHELL -ilc`；
- 使用外部 `printenv PATH`；
- macOS fallback 到 `launchctl getenv PATH`；
- 全部失败时保留 inherited PATH。

### Interface

```ts
export class LoginShellPath extends Context.Service<
  LoginShellPath,
  {
    readonly get: Effect.Effect<Option.Option<string>>;
  }
>()("desktop/LoginShellPath") {}
```

使用 `ChildProcessSpawner` 和 `Effect.timeout`，删除：

- `promisify(execFile)`；
- 自定义 `Exec` Promise interface；
- timeout option 注入。

探测失败是允许的 fallback，因此 public error channel 为 `never`；失败原因使用 debug log 记录。

## 7.3 `BackendSupervisor`

**Purpose:** 管理整个 desktop session 中 CLI backend 的状态和重启策略。

建议继续使用：

```text
apps/desktop/src/main/supervisor.ts
```

### Interface

```ts
export class BackendSupervisor extends Context.Service<
  BackendSupervisor,
  {
    readonly connection: BackendConnection;
    readonly status: Effect.Effect<BackendStatus>;
    readonly snapshot: Effect.Effect<BackendStatusSnapshot>;
    readonly changes: Stream.Stream<BackendStatusSnapshot>;
    readonly retry: Effect.Effect<void>;
  }
>()("desktop/BackendSupervisor") {}
```

最终不提供：

- `start()`；
- `stop()`；
- `onStatusChange()`；
- Node process handle；
- injected Promise clock。

首次启动属于 Layer acquisition；停止属于 Scope release。

### Construction

`BackendSupervisorLive` 使用 `Layer.scoped`：

1. 生成 token；
2. 计算 CLI entry；
3. 获取 login shell PATH；
4. 创建 `SubscriptionRef("starting")`；
5. 创建 retry Queue；
6. fork supervisor Fiber；
7. 等待 initial-ready Deferred；
8. initial ready 后返回 service。

首次启动失败时 Layer acquisition 失败，Scope 自动释放半初始化资源，Window 不创建。

### Restart loop

```text
first launch(port = 0)
  │
  ├── failure → fail layer, no automatic retry
  │
  └── ready(boundPort)
        ├── pin boundPort
        ├── status = ready
        └── await exit
              │
              ├── stable uptime → reset failure count
              └── fast failure  → increment failure count
                    │
                    ├── under limit
                    │     ├── status = reconnecting
                    │     ├── Effect.sleep(backoff)
                    │     └── launch(pinnedPort)
                    │
                    └── over limit
                          ├── status = failed
                          ├── Queue.take(retry)
                          ├── reset count
                          └── launch(pinnedPort)
```

允许状态转换：

| Current        | Next                       |
| -------------- | -------------------------- |
| `starting`     | `ready` or layer failure   |
| `ready`        | `reconnecting`             |
| `reconnecting` | `ready` or `failed`        |
| `failed`       | `reconnecting` after retry |

重复状态赋值不重复 emit。

### Clock

生产代码使用：

- `Clock.currentTimeMillis`；
- `Effect.sleep`。

测试使用：

- `TestClock.adjust`。

删除当前的：

- `delay?: (ms) => Promise<void>`；
- `now?: () => number`；
- microtask `flush()` loops。

## 7.4 `DesktopLifecycle`

**Purpose:** 提供可测试的 Electron quit 请求，而不是镜像整个 `app` interface。

```ts
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly requestQuit: Effect.Effect<void>;
  }
>()("desktop/DesktopLifecycle") {}
```

`requestQuit` 应先让 RPC procedure 形成 acknowledgment，再在下一事件循环触发 `app.quit()`，避免 quit 与 response serialization 竞争。

Renderer 不要求 quit RPC 正常返回；由应用退出导致的 aborted response 视为成功。

## 7.5 `WindowManager`

**Purpose:** 隐藏动态 BrowserWindow 引用和 macOS recreate 行为。

```ts
export class WindowManager extends Context.Service<
  WindowManager,
  {
    readonly ensureOpen: Effect.Effect<void>;
    readonly focus: Effect.Effect<void>;
  }
>()("desktop/WindowManager") {}
```

内部负责：

- BrowserWindow options；
- `ready-to-show`；
- `closed`；
- dev URL / `vibest://app/`；
- external link；
- main-frame navigation allowlist；
- runtime dispose 时 destroy window。

不向调用方返回 `BrowserWindow`。

## 7.6 `AppProtocol`

**Purpose:** 在一个 `protocol.handle("vibest")` 中完成 Desktop RPC 和 renderer asset dispatch。

它是 scoped module：

```text
acquire → protocol.handle
release → protocol.unhandle
```

它依赖：

- `BackendSupervisor`；
- `DesktopLifecycle`；
- renderer root；
- dev renderer origin。

因为 `AppProtocol` 依赖 core services，runtime dispose 时 protocol handler 应先移除，再释放 backend state。

## 8. Desktop Shell RPC

## 8.1 Contract location

使用 desktop-local contract：

```text
apps/desktop/src/shared/desktop-rpc.ts
```

不要放入：

- `packages/contract`：该 package 当前描述 CLI backend 的 Claude/Codex RPC；
- `packages/server`：Desktop procedure 不在 child process 中运行；
- `packages/client`：Desktop client 只存在于 Electron renderer entry。

4 个 procedure 不需要拆成多层目录。

## 8.2 Contract

```text
desktop.bootstrap
  input: void
  output:
    os
    backend.httpBaseUrl
    backend.wsBaseUrl
    backend.token
    status
    statusRevision

desktop.status.watch
  input: { after: number }
  output: { revision: number; status: BackendStatus }

desktop.backend.retry
  input: void
  output: void

desktop.app.quit
  input: void
  output: void
```

示意：

```ts
export const BackendStatusSchema = z.enum(["starting", "ready", "reconnecting", "failed"]);

export const DesktopBootstrapSchema = z.object({
  os: z.string(),
  backend: z.object({
    httpBaseUrl: z.string(),
    wsBaseUrl: z.string(),
    token: z.string().min(1),
  }),
  status: BackendStatusSchema,
  statusRevision: z.number().int().nonnegative(),
});

export const desktopContract = {
  bootstrap: oc.output(DesktopBootstrapSchema),
  status: {
    watch: oc
      .input(z.object({ after: z.number().int().nonnegative() }))
      .output(BackendStatusSnapshotSchema),
  },
  backend: {
    retry: oc.output(z.void()),
  },
  app: {
    quit: oc.output(z.void()),
  },
};
```

无 input/output procedure 的最终写法以仓库锁定的 oRPC beta API 为准。

## 8.3 Main router

文件：

```text
apps/desktop/src/main/desktop-rpc.ts
```

参考远端 main 新增的 `packages/server/src/rpc/context.ts`：

```ts
export type DesktopRpcContext = WithEffectContext<BackendSupervisor | DesktopLifecycle>;
```

procedure：

```ts
bootstrap.effect(function* () {
  const backend = yield* BackendSupervisor;
  const current = yield* backend.snapshot;

  return {
    os: process.platform,
    backend: backend.connection,
    status: current.status,
    statusRevision: current.revision,
  };
});
```

```ts
retry.effect(function* () {
  const backend = yield* BackendSupervisor;
  yield* backend.retry;
});
```

```ts
quit.effect(function* () {
  const lifecycle = yield* DesktopLifecycle;
  yield* lifecycle.requestQuit;
});
```

status：

```ts
watch.effect(function* ({ input }) {
  const backend = yield* BackendSupervisor;
  const current = yield* backend.snapshot;
  if (current.revision > input.after) return current;

  return yield* backend.changes.pipe(
    Stream.filter((next) => next.revision > input.after),
    Stream.runHead,
    Effect.timeoutOrElse({ duration: "20 seconds", orElse: () => Effect.succeed(Option.none()) }),
    Effect.map(Option.getOrElse(() => current)),
  );
});
```

revision 防止 Renderer 在 poll 间隙丢失状态转换；20 秒 timeout 保证即使底层 request cancellation 未传播，也不会留下永久 subscription。

## 8.4 Effect context

Desktop RPC 使用 root `DesktopMainLayer` 的同一个 context。

禁止：

```ts
ManagedRuntime.make(...) // inside each request or inside RPC handler
```

`AppProtocol` Layer acquisition 时获取所需 Effect context，并闭包到 Fetch handler：

```ts
const rpcContext: DesktopRpcContext = {
  "effect/context": desktopEffectContext,
};
```

这与远端 main 的 server RPC context pattern 一致，但 Desktop runtime 必须在 Electron quit 时 dispose。

## 8.5 Fetch handler

使用：

```ts
new RPCHandler(desktopRouter, {
  clientInterceptors: [logErrors],
  plugins: [new CORSHandlerPlugin({ origin: allowedOrigin })],
});
```

错误日志至少包含：

- procedure path；
- typed error / cause；
- 是否为 cancellation。

Abort 不按 error 记录；每个 status poll 最长持有 20 秒。

## 9. Custom protocol transport

## 9.1 Scheme privileges

现有：

```ts
{ standard: true, secure: true, supportFetchAPI: true }
```

改为：

```ts
{
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
}
```

最终 transport 使用 bounded long-polling，因此不注册 `stream: true`；`corsEnabled: true` 用于 dev renderer 从 HTTP origin 调用 `vibest://app`。

## 9.2 Dispatch order

```text
host !== app
  └── 404

pathname startsWith /api/desktop-rpc
  ├── oRPC matched     → RPC Response
  └── oRPC not matched → 404

other pathname
  ├── real file → net.fetch(file URL)
  └── otherwise → index.html SPA fallback
```

Desktop RPC unknown path 不能落入 SPA fallback。

`resolveAssetPath` 继续保持纯函数，并修复 malformed `%` 导致的 `decodeURIComponent` 异常：返回 404，不让 handler reject。

## 9.3 Development CORS

production：

```text
renderer origin = vibest://app
RPC origin      = vibest://app
```

dev：

```text
renderer origin = http://localhost:<vite-port>
RPC origin      = vibest://app
```

要求：

- 只允许 `ELECTRON_RENDERER_URL` 的 exact origin；
- 使用 oRPC `CORSHandlerPlugin` 处理 preflight；
- CSP `connect-src` 加入 `vibest:`；
- 保留 oRPC 默认 CSRF guard，除非真实集成测试证明不兼容；
- 不使用 `*`。

## 9.4 Transport feasibility gate

Phase 0 的验证结果：

1. POST body 可从 Renderer 到达 `protocol.handle`；
2. unary oRPC response 可解码；
3. production custom origin 和 dev HTTP origin 均可 bootstrap；
4. allowed origin 的 CORS preflight 成功，其他 origin 没有 allow header；
5. Fetch EventIterator 能传值，但 cancellation 未可靠执行 server iterator finalizer。

因此采用第一级降级：保留 custom protocol + oRPC，把 status 改为 bounded long-polling。未增加 loopback Desktop RPC server，也未回退 Electron IPC。

## 10. Renderer migration

## 10.1 Client

新增：

```text
apps/desktop/src/renderer/desktop-client.ts
```

```ts
const link = new RPCLink({
  origin: "vibest://app",
  url: "/api/desktop-rpc",
});
```

必须显式指定 custom origin；dev 下不能使用 `location.origin`。

## 10.2 Async bootstrap

当前 Renderer 同步读取 `window.vibest`。改为：

```text
create desktop client
  │
  ├── await desktop.bootstrap
  ├── create Platform adapter
  ├── start status watch
  └── mount React
```

示意：

```ts
const bootstrap = await desktopClient.bootstrap();
const platform = createDesktopPlatform(desktopClient, bootstrap);
createRoot(root).render(createApp(platform));
```

bootstrap 失败时显示明确 startup failure UI；不能用空 URL、空 token 或假 `ready` 状态继续启动。

## 10.3 Keep existing `Platform` interface

远端 main 已经有：

```ts
Platform =
  | { host: "web" }
  | {
      host: "desktop";
      os: string;
      backend: BackendConnection;
      status: BackendStatusFeed;
    };
```

本次不重构该 interface。新增 adapter：

```text
initial   ← bootstrap.status
subscribe ← desktop.status.watch
retry     ← desktop.backend.retry
quit      ← desktop.app.quit
```

这样：

- `apps/app` 不依赖 Desktop RPC contract；
- web build 不包含 desktop transport；
- 现有 overlay 可继续工作；
- Renderer 不需要 Effect Runtime。

## 10.4 Status long-poll reconnect

subscription adapter：

```text
subscribe(listener)
  ├── revision = bootstrap.statusRevision
  ├── create AbortController
  ├── status.watch({ after: revision })
  │     ├── newer revision → listener + immediately issue next poll
  │     └── 20s timeout/current revision → immediately issue next poll
  ├── transport error → bounded retry: 250ms → 5s
  └── unsubscribe → abort active request + stop polling
```

`SubscriptionRef` 同时保存 status 和单调递增 revision；poll 先读取 snapshot，再订阅 changes，因此在读取和订阅之间发生的 transition 也不会丢失。

Renderer transport retry 与 backend supervisor backoff 是两套不同策略，不能共用 failure count。

## 10.5 Remove preload

Renderer 切换与 IPC 删除必须是一个原子提交。

删除：

```text
apps/desktop/src/preload/index.ts
apps/desktop/src/preload/index.d.ts
apps/desktop/src/shared/bridge.ts
```

修改：

- `electron.vite.config.ts`：删除 preload build；
- `BrowserWindow.webPreferences`：删除 preload path；
- `tsconfig.node.json`：删除 preload include；
- `tsconfig.web.json`：删除 preload declaration include；
- `package.json`：删除 `@electron-toolkit/preload`；
- 删除所有 IPC imports 和 handlers。

继续保留：

```ts
sandbox: true;
contextIsolation: true;
nodeIntegration: false;
```

## 11. Root runtime 和启动顺序

## 11.1 Root runtime

使用一个：

```ts
const runtime = ManagedRuntime.make(DesktopMainLayer);
```

不使用 `NodeRuntime.runMain`，因为 Electron owns readiness、callbacks 和 quit。

## 11.2 Layer graph

```text
Node FileSystem + Path
       │
       ▼
NodeChildProcessSpawner
       │
       ├── LoginShellPath
       └── BackendProcess
               │
               ▼
       BackendSupervisor
               │
               ├── Desktop RPC
               └── AppProtocol

DesktopLifecycle ─────────────┘
WindowManager ────────────────┘
```

`AppProtocol` 必须依赖 core services，避免 root dispose 时先释放 service、后移除 handler。

## 11.3 Startup sequence

```text
module load
  ├── registerAppScheme
  ├── requestSingleInstanceLock
  └── app.whenReady
        │
        ▼
    build DesktopMainLayer
        ├── backend initial ready
        ├── desktop RPC handler ready
        └── app protocol registered
        │
        ▼
    WindowManager.ensureOpen
        │
        ▼
    Renderer bootstrap
```

首次 backend start 或 protocol setup 失败：

- native error dialog；
- 不创建 Window；
- dispose runtime；
- quit。

## 11.4 Single-instance fix

当前 main 在 lock 失败后调用 `app.quit()`，但仍继续注册 readiness path。

新入口必须使用明确分支：

```ts
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  startPrimaryInstance();
}
```

secondary instance 不能启动 shell PATH probe、backend、runtime 或 protocol handler。

## 11.5 Graceful quit

第一次 `before-quit`：

1. `preventDefault()`；
2. `await runtime.dispose()`；
3. 标记 disposed；
4. 再次 `app.quit()`。

dispose 必须：

- 关闭 status RPC streams；
- 取消 backoff sleep；
- kill CLI child；
- 移除 protocol handler；
- destroy window resources。

SIGKILL 不执行 finalizer。hard-kill orphan guard 仍是独立问题。

## 12. Typed errors

新增：

```text
apps/desktop/src/main/errors.ts
```

最小 error set：

```ts
BackendSpawnError;
BackendReadyTimeout;
BackendExitedBeforeReady;
DesktopProtocolRegistrationError;
```

规则：

| Situation                      | Behavior                            |
| ------------------------------ | ----------------------------------- |
| initial backend failure        | typed error → native dialog → quit  |
| later backend crash            | status transition，不作为 RPC error |
| max fast failures              | `failed` status                     |
| malformed Desktop RPC input    | contract error                      |
| status unsubscribe             | normal request abort                |
| unexpected status poll failure | Renderer bounded reconnect          |
| missing bootstrap field        | fail decoding，不提供默认值         |
| Effect defect                  | log full Cause，不序列化 raw cause  |

删除 `(error as Error).message` 作为主要错误模型。

## 13. 文件变更

### Add

```text
apps/desktop/src/main/errors.ts
apps/desktop/src/main/desktop-lifecycle.ts
apps/desktop/src/main/desktop-rpc.ts
apps/desktop/src/main/window-manager.ts
apps/desktop/src/shared/desktop-rpc.ts
apps/desktop/src/renderer/desktop-client.ts
apps/desktop/src/renderer/desktop-platform.ts
apps/desktop/e2e/tests/desktop-rpc.spec.ts
```

### Rewrite substantially

```text
apps/desktop/src/main/backend.ts
apps/desktop/src/main/supervisor.ts
apps/desktop/src/main/shell-path.ts
apps/desktop/src/main/protocol.ts
apps/desktop/src/main/index.ts
apps/desktop/src/renderer/main.tsx
```

### Modify

```text
apps/desktop/package.json
apps/desktop/electron.vite.config.ts
apps/desktop/tsconfig.node.json
apps/desktop/tsconfig.web.json
apps/desktop/src/renderer/index.html
apps/app/src/core/desktop/backend-status-overlay.tsx
```

### Delete

```text
apps/desktop/src/preload/index.ts
apps/desktop/src/preload/index.d.ts
apps/desktop/src/shared/bridge.ts
```

### Expected no change

```text
packages/contract/**
packages/client/**
packages/server/src/rpc/**
packages/vibest/src/node/**
```

如果实现需要修改这些 backend packages，应先重新确认 module seam；Desktop Shell RPC 默认不应泄漏到 backend packages。

## 14. 测试方案

## 14.1 `BackendProcess`

覆盖：

- first launch port 0；
- valid ready line；
- ordinary stdout；
- split chunks；
- exit before ready；
- spawn failure；
- 30s timeout；
- stdout ready 后继续 drain；
- Scope close kills child；
- stderr 不阻塞。

增加一个真实 fake CLI fixture，而不仅是 mock process object。

## 14.2 `LoginShellPath`

覆盖：

- Windows 不执行；
- zsh/bash interactive login；
- fish 通过 `printenv PATH` 得到 colon-separated value；
- shell failure；
- macOS launchctl fallback；
- Linux 不调用 launchctl；
- timeout fallback；
- 全部失败返回 `None`。

## 14.3 `BackendSupervisor`

使用 fake `BackendProcess` Layer + `TestClock`：

- initial success；
- initial failure no retry；
- same pinned port；
- exponential backoff + cap；
- stable reset；
- terminal failed；
- retry idempotence；
- repeated retry click 不并发 launch；
- runtime dispose during sleep；
- runtime dispose during startup；
- current process finalization；
- status transition order。

## 14.4 Desktop RPC contract/router

覆盖：

- bootstrap output；
- current status read；
- retry delegation；
- quit scheduling；
- bootstrap status + revision；
- long poll 等待下一 revision；
- 落后 revision 立即返回；
- unknown route 404；
- cancellation 不输出 error log。

router test 应像远端 main 的 `rpc-codex.test.ts` 一样，使用 `ManagedRuntime` + real context，不只测 procedure function。

## 14.5 Protocol integration

必须经过真实 Electron custom protocol：

- POST body；
- unary oRPC response；
- repeated bounded long polls；
- request AbortSignal；
- production same-origin；
- dev CORS；
- denied origin；
- asset serving；
- SPA deep link；
- RPC unknown path 404；
- malformed percent encoding 404。

## 14.6 Renderer/E2E

覆盖：

- 无 preload 也能启动；
- bootstrap 完成后才 mount；
- bootstrap failure UI；
- backend kill → reconnecting；
- restart → ready；
- repeated crash → failed；
- Retry；
- Quit；
- status long-poll reconnect；
- browser mode 不包含 desktop RPC；
- Claude session 恢复文案与行为；
- Codex 场景不承诺透明 session restore。

## 14.7 Verification commands

```bash
pnpm --filter desktop test
pnpm --filter desktop typecheck
pnpm --filter desktop build
pnpm --filter desktop e2e
pnpm --filter desktop build:unpack
pnpm check
```

额外检查：

```bash
rg "ipcMain|ipcRenderer|contextBridge|window\.vibest" apps/desktop
```

预期无结果。

## 15. 实施顺序

每一步从新分支开始，基线为最新 `origin/main`，不要继续使用已合并 feature branch。

## Phase 0 — Transport gate

**Objective:** 证明 custom protocol 支持 oRPC unary、status transport、abort 和 dev CORS。

**Paths:**

```text
apps/desktop/e2e/tests/desktop-rpc.spec.ts
apps/desktop/src/main/protocol.ts or isolated spike fixture
```

**Exit:** 已选择 bounded long-polling；EventIterator cancellation 未通过 finalizer gate。

## Phase 1 — Effect dependencies and errors

- 增加 Effect 4 Node platform dependencies；
- 增加 desktop typed errors；
- 增加 test Layer helpers；
- 不改变生产行为。

## Phase 2 — Effect shell PATH

- `LoginShellPath` service；
- Node child process adapter；
- 保持所有现有 fallback。

## Phase 3 — Scoped `BackendProcess`

- ready Deferred；
- stdout/stderr Stream；
- timeout；
- process Scope；
- fake CLI integration test。

## Phase 4 — Effect `BackendSupervisor`

- `Layer.scoped`；
- `SubscriptionRef`；
- retry Queue；
- `TestClock`；
- 保留现有 token、port 和 status semantics。

为下一阶段保留一个临时同步 snapshot adapter 供现有 IPC bootstrap 使用；该 adapter 必须在 IPC 删除阶段一起删除，不能成为最终 interface。

## Phase 5 — Root `ManagedRuntime`

- 组装 Desktop core Layer；
- startup error handling；
- graceful dispose；
- single-instance fix；
- WindowManager integration。

此时可以暂时保留旧 IPC transport，但 backend state 已由 Effect service 唯一持有。

## Phase 6 — Desktop RPC contract/router

- desktop-local contract；
- `.effect` procedures；
- root context；
- revision-based status long poll；
- router tests。

先 additive 接入，不立即删除旧 Renderer path，确保 commit 可验证。

## Phase 7 — Combined protocol transport

- RPC dispatch before assets；
- scheme privileges；
- CORS/CSP；
- bounded long-poll dispatch；
- protocol E2E。

## Phase 8 — Renderer cutover and IPC deletion

一个原子提交完成：

- async bootstrap；
- desktop client；
- Platform adapter；
- status watch/reconnect；
- Retry/Quit RPC；
- 删除 IPC；
- 删除 preload；
- 删除 bridge；
- 删除临时 snapshot adapter。

## Phase 9 — Hardening

- navigation allowlist；
- malformed URI；
- normal quit process-tree verification；
- package size inspection；
- provider-neutral overlay copy；
- full E2E。

## 16. Integration dependency map

| Integration                                 | Depends on | Real verification               |
| ------------------------------------------- | ---------- | ------------------------------- |
| `LoginShellPath → NodeChildProcessSpawner`  | Phase 1    | real shell/fake executable      |
| `BackendProcess → @vibest/cli entry`        | Phase 3    | fake CLI ready protocol         |
| `BackendSupervisor → BackendProcess`        | Phase 4    | Layer integration + TestClock   |
| `DesktopMainLayer → BackendSupervisor`      | Phase 5    | startup wait + dispose kill     |
| `DesktopRpcContext → DesktopMainLayer`      | Phase 6    | router client with real context |
| `protocol.handle → oRPC FetchHandler`       | Phase 7    | Electron Request/Response test  |
| `Renderer client → custom protocol`         | Phase 8    | E2E bootstrap                   |
| `status overlay → SubscriptionRef.changes`  | Phase 8    | kill/restart E2E                |
| `quit RPC → runtime.dispose`                | Phase 8    | child process gone after quit   |
| outer CLI kill → nested Codex child cleanup | Phase 9    | process-tree integration check  |

任何 integration task 不允许只用 stub 证明完成。

## 17. 风险和非目标

### 17.1 Effect beta

Effect 和 Node platform 必须精确对齐版本。实现以安装版本的 API 为准，不照搬 Effect 3 示例。

### 17.2 Custom protocol status transport

Phase 0 证明 POST、unary 和 CORS 可用，但 EventIterator cancellation 没有可靠释放 server stream。实现已使用 20 秒 bounded long-polling，避免永久资源泄漏。

### 17.3 Hard kill

Effect finalizer 不能处理 SIGKILL。正常 quit 可保证清理；Electron crash / SIGKILL 的 parent-death guard 另行设计。

### 17.4 Codex recovery

本次不实现 Codex session resume。outer backend restart 后 Codex session 是否可恢复必须由 harness/backend 单独解决。

### 17.5 Renderer Effect adoption

Renderer 不引入 Effect Runtime。oRPC client 保持 Promise interface，并用 AbortSignal 停止 long-poll loop。

### 17.6 Effect RPC

本次不同时引入 `effect/unstable/rpc`。未来若 Renderer 全面 Effect 化，再重新评估。

### 17.7 Package footprint

必须从 `@effect/platform-node/NodeChildProcessSpawner`、`NodeFileSystem` 和 `NodePath` subpath 直接导入。barrel import 会 eager-load `NodeRedis`，导致 packaged app 在没有 `ioredis` 时启动失败；unpacked smoke 已覆盖此回归。

## 18. 验收标准

完成条件：

- 基于最新 `origin/main` 实施；
- `BackendProcess` 的 child lifetime 属于 Scope；
- `BackendSupervisor` 无 public `stop()`、listener Set、Promise clock；
- ready handshake 无手写 settle Promise/timer；
- restart delay 可 interruption；
- status source of truth 是 `SubscriptionRef`；
- Renderer/Main 使用 `vibest://app/api/desktop-rpc`；
- desktop bootstrap 在 React mount 前完成；
- bootstrap 提供 current status/revision，long poll 可 abort、可 reconnect；
- Retry 和 Quit 是 typed oRPC procedures；
- `ipcMain`、`ipcRenderer`、`contextBridge`、`window.vibest` 全部删除；
- preload build 和 preload files 删除；
- BrowserWindow 仍保持 sandbox、context isolation、no Node integration；
- backend token 和 pinned port 语义不变；
- normal quit dispose runtime 并终止 CLI child；
- custom protocol unary、long-poll recovery、shutdown 和 dev CORS 有 Electron tests；
- overlay 不错误承诺 Codex session recovery；
- desktop test、typecheck、build、unpacked smoke 和 E2E 全部通过。
