# Desktop Effect v4 Review Fixes Plan

- **Base:** `feat/desktop-effect-native@f7f583f`（PR #102）
- **Date:** 2026-07-15
- **Scope:** `apps/desktop/src/main`、`apps/desktop/AGENTS.md`
- **Status:** Implemented

> API 结论均已对照本仓库安装的 `effect@4.0.0-beta.97` 与 `@orpc/experimental-effect@2.0.0-beta.16` 源码核验。
>
> 以下部分是地道 v4 用法，**不改**：`effect/unstable/process` 子进程管理与 Scope 化资源释放、`Effect.result` + `Result` 检查、`Effect.timeoutOrElse` / `Effect.catch`、克制的 Context 使用（仅一个 `Context.Service`，其余为普通能力值）、`while(true)` 监督循环（策略是真状态机，`Schedule` 组合子表达反而晦涩，纯计算已抽出为 `restartBackoff`）。

## 1. 问题清单（按优先级）

| #   | 问题                                                                            | 层级   | 结论           |
| --- | ------------------------------------------------------------------------------- | ------ | -------------- |
| P2  | `watchBackendStatus` 重复实现 v4 `SubscriptionRef.changes` 已保证的 replay 语义 | 简化   | 实施           |
| P3  | 边缘处类型化错误缺失（`ManagedRuntime<_, unknown>`）与 `RunCommand` 死参数      | 打磨   | 实施           |
| P5  | `setStatus` 的 get-then-set 依赖未记录的单写者不变量                            | 文档   | 注释即可       |
| P1  | RPC handler 运行在裸默认环境，`Context.empty()` 丢弃组合根服务与 references     | 可观测 | 随 P4 一个提交 |
| P4  | 日志双轨制：`Effect.log*` 与裸 `console.*` 并存                                 | 可观测 | 随 P1 一个提交 |
| P6  | 后续独立决策项（不阻塞合并）                                                    | 记录   | 见 §7          |

## 2. P2 — 用 v4 replay 语义简化 `watchBackendStatus`

### 现状

```ts
// application/desktop-application.ts
Stream.concat(Stream.fromEffect(backend.snapshot), backend.changes).pipe(
  Stream.filter((s) => s.revision > after),
  Stream.changesWith((p, n) => p.revision === n.revision),
);
```

v4 源码确认：`SubscriptionRef.make` 底层是 `PubSub.unbounded({ replay: 1 })` 且构造时即 publish 初值，`changes = Stream.fromPubSub(self.pubsub)`。因此 **`changes` 在订阅时必然先重放当前值**。`concat` 前缀是 v3 时代防漏手段，在 v4 只制造重复快照，`changesWith` 又是为了去掉这个重复。三层机制里两层在互相抵消。

### 改法

```ts
watchBackendStatus: (after) =>
  backend.changes.pipe(Stream.filter((snapshot) => snapshot.revision > after)),
```

语义不变：replay(1) 保证订阅即得当前状态；`after` 游标保证 bootstrap 与订阅之间的衔接（revision 单调递增，重复与乱序都被 filter 消除）。renderer 侧 `desktop-platform.ts` 的 `snapshot.revision <= revision` 防御保留，作为传输层重连时的二道闸。

### 验证

`desktop-application.test.ts` 锁定 replay + resume cursor 的**组合语义**（而非实现细节）：

1. 状态先变到 revision 1，再订阅 `after: 0` → 首个元素立即为 revision 1；
2. 订阅 `after: 1` → 不重放 revision 1，直到 revision 2 才产生元素。

E2E `desktop-rpc.spec.ts` 的 status stream 用例不回归。

## 3. P3 — 类型化错误与死参数

### 3.1 `startDesktopRuntime` 保留启动错误类型

`makeDesktopRuntimeLayer` 的实际错误类型是 `BackendStartError | ProtocolRegistrationError`，但局部变量手写为 `ManagedRuntime<DesktopRuntime, unknown>`，随后错误弹窗只能做 `instanceof Error` 字符串手术。注意 JS `catch` 里按 `_tag` 分支并不能真正保留类型（catch 变量仍是 `unknown`，typed failure 与 defect 混流），正确做法是在 Effect 世界内转成 `Result`：

```ts
let runtime: ReturnType<typeof makeRuntime> | undefined;

const outcome = yield * Effect.result(runtime.contextEffect);
// outcome: Result<Context<...>, BackendStartError | ProtocolRegistrationError>
```

在 Promise 成功值中拿到类型化 `Result`，失败分支交给纯函数 `formatStartupFailure(error)` 生成弹窗文案（可独立单测）；外层 catch 只兜 defect / 非预期异常。文案覆盖全部四支：`BackendSpawnError`、`BackendReadyTimeout`、`BackendExitedBeforeReady`（附 exitCode）、`ProtocolRegistrationError`。

### 3.2 删除 `RunCommand` 的死参数

`login-shell-environment.ts` 中 `RunCommand` 声明了 `timeoutMs` 参数，但生产适配器 `resolveLoginShellEnvironmentWith` 忽略它，真正的超时由外层 `Effect.timeoutOption` 施加。超时必须只有一个来源：

```ts
export type RunCommand = (file: string, args: readonly string[]) => Effect.Effect<string, unknown>;
```

**错误类型保持 `unknown`，不收窄**：该 seam 的既定语义是「任意探测失败都吞掉回退」，错误不越过模块边界、无消费方 narrow，收窄只增加测试构造成本，无接口 leverage。在类型旁加一行注释说明这是有意的内部语义。`runWithTimeout` 内的 `Effect.timeoutOption(timeoutMs)` 保持为唯一超时机制（fiber 中断 → spawner scope 自动杀 shell 进程，v4 结构化并发的正确用法，不动）。同步更新 `login-shell-environment.test.ts` 中 fake RunCommand 的签名。

## 4. P5 — 记录 `setStatus` 的单写者不变量

v4 源码确认 `SubscriptionRef.set/modify` 无条件 publish（`setUnsafe` 总是 `PubSub.publishUnsafe`），因此现有「先读、状态相同则跳过写」的形态是**必要的**（避免向订阅者重放 no-op），不宜机械换成 `modify`。get-then-set 的正确性依赖 supervise 是唯一写者这一事实，但代码没有记录。

改法：只加注释，不改结构：

```ts
// supervise 是 statusRef 的唯一写者，因此 get→set 无竞态；
// 不用 modify：v4 的 set/modify 无条件 publish，会向订阅者重放 no-op。
```

## 5. P1 + P4 — Observability：RPC handler 接入组合根 Context，日志统一 Effect logger

两项相互依赖（logger 在 v4 中是 Context 服务），合为一个独立提交，不与上述清理混流。

### 5.1 背景与定位

`@orpc/experimental-effect` 的 `handlerGen` 实现：

```js
// dist/shared/experimental-effect.C9oJcd5q.mjs
let ef = Effect.gen(() => handler(opts, input)).pipe(succeedOnORPCError);
if (Context.isContext(opts.context["effect/context"])) {
  ef = ef.pipe(Effect.provide(opts.context["effect/context"]));
}
if (typeof opts.context["effect/wrap"] === "function") {
  ef = opts.context["effect/wrap"](ef, opts);
}
return runPromise(ef, { signal: opts.signal }); // Effect.runPromiseExit，全局默认 runtime
```

两个事实决定本项的定位与做法：

1. **传入 Context 只能补齐 ServiceMap**（v4 已把 logger、log level、tracing 等 references 并入 ServiceMap），handler fiber 仍由全局 `Effect.runPromiseExit` 启动，不进入 `ManagedRuntime` 的父 Scope，也不受 `dispose` 约束。本项是「给 detached handler 补充组合根服务与 runtime references」，不是把 handler 纳入 runtime 生命周期。曾评估真正纳入 runtime 的做法（弃用 `.effect` 扩展、handler 手动 `runtime.runPromise`），因牺牲生成器语法与 orpc 取消/错误集成而放弃。
2. **`effect/wrap` 包在 `Effect.provide(effect/context)` 外侧**：在 wrap 里追加的日志 tap 读到的是外层默认 Context。wrapper 必须自己在最外层再 provide 一次，才能让 tap 使用组合根 logger。

### 5.2 改法

1. 组合根内捕获当前 Context 并下传：

```ts
// desktop-runtime.ts（Layer.effect 的 gen 体内，rpcServer 构造前）
const rpcContext = yield * Effect.context<never>();
const rpcServer = makeDesktopRpcServer(application, rpcContext);
```

2. `makeDesktopRpcServer` 用它替代 `Context.empty()`，并用工厂闭包构造 wrapper（注意 v4 的 API 是 `Effect.tapCause`，v3 的 `tapErrorCause` 已不存在）：

```ts
// rpc/desktop-rpc-server.ts
function makeWrapDesktopRpcEffect(rpcContext: Context.Context<never>) {
  return <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logError("desktop rpc failed", cause),
      ),
      Effect.provide(rpcContext), // 覆盖 tap 本身，见 §5.1 事实 2
    );
}

export function makeDesktopRpcServer(
  application: DesktopApplication,
  rpcContext: Context.Context<never>,
): DesktopRpcServer {
  const handler = new RPCHandler(makeDesktopRouter(application));
  const context: DesktopRpcContext = {
    "effect/context": rpcContext, // 接口必填字段，负责 handler 类型层
    "effect/wrap": makeWrapDesktopRpcEffect(rpcContext),
  };
  // ...
}
```

删除 `desktop-router.ts` 的 `logDesktopRpcErrors` clientInterceptor（promise 层 try/catch），取消判别从 `AbortError` 特判换成 `Cause.hasInterruptsOnly`（orpc 自身即用它区分取消）。

3. **wrapper 语义写入注释并测试**：`succeedOnORPCError` 在 provide/wrap 之前执行，wrapper 只见非预期 failure / defect —— expected `ORPCError` 不打日志是有意策略。测试覆盖三类：expected ORPCError、defect、client cancellation。
4. **console 清理**（实际站点：`node-backend-process.ts` 3 处、`desktop-router.ts` 1 处、`main-window.ts` 1 处；`desktop-runtime.ts` 无裸 console，其失败路径走 `dialog.showErrorBox`，保留）：
   - 子进程输出泵改 `Effect.log` + `Effect.annotateLogs({ source: "vibest-server", fd: "stdout" | "stderr" })`；
   - `main-window.ts` 的 `loadURL().catch` 位于 Promise 回调、无 fiber 可依，不机械替换：`ensureOpen` 从 `Effect.sync` 改为 `Effect.gen`，同步建窗后 fork `Effect.tryPromise(() => window.loadURL(target))` 并 `Effect.catchCause(Effect.logError)`，让窗口加载进入结构化并发。
5. 根部暂不配置自定义 Logger layer（默认 logger 落 console，行为不变）；打包版日志落盘成为将来在组合根加一个 Layer 的单点改动。
6. `AGENTS.md` Effect usage 补两条：「RPC handler 通过 `effect/context` 与 wrapper 外层 provide 继承组合根 Context（含全部 references），这是有意把组合根 ServiceMap 交给 RPC，禁止 `Context.empty()`」；「Main 进程内禁止裸 `console.*`，统一 `Effect.log*`；子进程原始输出通过 annotation 标记来源」。

### 5.3 验证

- 用 `Context.Reference`（自定义 logger 或 minimumLogLevel）做回归测试，断言在 **handler body 与 wrapper 的 tap 内都生效**（不通过类型断言把 Tag 服务塞进 `R = never` 的 handler）。
- §5.2.3 的三类 wrapper 语义用例。
- 既有 desktop 测试与 MessagePort stream cancellation gate 不回归。

## 6. 依赖规则影响

`rpc/**` 的构造函数签名新增一个 `Context.Context<never>` 参数，仍由组合根注入，不引入新的 import 方向；`AGENTS.md` 依赖规则不变，仅补 §5.2.6 两条实现规则。

## 7. P6 — 后续独立决策项（不在本计划实施）

1. **组合根与 Electron 生命周期拆分：暂缓**。`desktop-runtime.ts` 同时承载 Layer 装配与约 90 行命令式 app 生命周期，但相关知识当前 locality 高；拆到 `index.ts` 违反「index 只依赖 desktop-runtime」规则，拆到浅模块只是移动代码、增加 callback 接口，没有隐藏复杂度。触发条件：生命周期外壳显著增长，或出现第二种宿主 adapter。
2. **首启 `starting` 状态形同虚设**：`makeLocalBackend` 返回前 `Deferred.await(initial)`，窗口在 backend ready 后才创建，冷启动（最长 30s）无窗口，状态机的 `starting` 只对重连可见。这是实际产品行为而非 Effect 用法问题，由 UX 决定：删除无效公开状态，或先开窗并让 `bootstrap` 的 `backend.connection` 变为可等待。
3. **契约层 Effect Schema**：orpc effect 扩展内置 `Schema.toStandardSchemaV1`，`shared/desktop-rpc.ts` 可用 Effect Schema 替代 zod 并与 `Data.TaggedError` 统一。仓库其余契约均为 zod，一致性优先，暂缓。

## 8. 实施顺序与验证

顺序（每项独立提交、独立验证）：

1. **P2**：删除 concat/changesWith 冗余，补 §2 双性质测试；
2. **P3.2**：仅删 `RunCommand` 死参数；
3. **P3.1**：`Effect.result` + `formatStartupFailure` 纯函数 + 四分支文案测试；
4. **P5**：单写者不变量注释；
5. **P1 + P4**：observability 提交（§5 全部内容）。

前四项是低风险、可独立验证的简化与打磨；P1/P4 涉及执行 Context 和日志语义，不与无关清理混在同一批修改。

每步完成后按 `apps/desktop/AGENTS.md` 验证矩阵执行：

```
pnpm --filter desktop test
pnpm --filter desktop typecheck
pnpm --filter desktop build
pnpm --filter desktop e2e
pnpm check
pnpm test
```

关键回归项：MessagePort stream cancellation 的 server finalizer、renderer reload 换 port 不重启 backend、backend crash/recovery/Retry/Quit、`HTTPS_PROXY` 透传（P3.2 触碰 login-shell 路径）。

## 9. 决策记录

**`effect/context` 的捕获范围：采用方案 A（全量捕获）。**

- **方案 A（全量捕获，§5.2 现方案）**：`yield* Effect.context<never>()` + 在 `AGENTS.md` 写明意图。优点：根部新增 reference（logger、log level、tracer）自动对 RPC 生效，无同步负担；handler 的 `R = never` 类型已阻止消费业务服务。缺点：运行时实际交出完整 ServiceMap，`never` 类型不反映内容。
- **方案 B（显式最小 Context）**：只构造 RPC 明确需要的 reference 集合。优点：交给 RPC 层的能力显式可见。缺点：每次根部配置变化需同步 RPC 侧，选 key 的代码会漂移。
- **影响面**：只是 §5.2 第 1 步的一行代码与 `AGENTS.md` 一条规则的措辞；可先按方案 A 实施，改方案 B 是局部替换，不阻塞其余各项。
