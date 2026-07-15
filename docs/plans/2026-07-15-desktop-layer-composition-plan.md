# Desktop Layer Composition Plan

- **Base:** `origin/main@037ac24`（PR #102 合并后）
- **Date:** 2026-07-15
- **Scope:** `apps/desktop/src/main`、`apps/desktop/AGENTS.md`
- **Status:** Proposed

> 把 Electron Main 的能力模块从「构造参数手工穿线」迁移到 Effect v4 的 Tag + Layer 组合。这是纯结构迁移：不改任何运行时行为，不动 renderer、preload、RPC 契约与传输。

## 1. 动机

PR #102 采用「显式构造参数 + 普通能力值」接线，对当时的单消费者规模是正确的。触发迁移的三个事实：

1. **依赖扇出即将出现。** `MainWindow`（tray、menu、deep-link、auto-update、第二窗口都需要 `ensureOpen`/`focus`）和 `LocalBackend`（tray/menu 状态）会很快有多个消费者。手工穿线的组合根随消费者数量呈 N×M 增长；Layer 图的拓扑构建与 memoization 正是为此设计。
2. **task / terminal / worktree 服务将以 Effect-native 形式回归**（PR #102 删除的旧实现）。在服务数量膨胀前换好地基，迁移是 5 个模块的机械操作；之后做则要连带所有新服务。
3. **`DesktopRuntime` 是补偿性包装的症状。** 全仓唯一的 `Context.Service`，存在理由只是 lifecycle 回调需要可 `yield*` 的对象，内部仅转发 `ensureWindow`/`focus`。`MainWindow` 成为 service 后它整个消失。

## 2. 目标形态

### 2.1 服务清单

| Tag                  | 所在文件                             | 依赖                                       | Live Layer 位置                                                        |
| -------------------- | ------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------- |
| `DesktopConfig`      | `desktop-config.ts`（新增）          | 无（读 `app`/`process`/env）               | 同文件                                                                 |
| `LocalBackend`       | `backend/local-backend.ts`           | `DesktopConfig`、`ChildProcessSpawner`     | `backend/local-backend-live.ts`（adapter 侧，含 login-shell 环境解析） |
| `DesktopApplication` | `application/desktop-application.ts` | `LocalBackend`                             | 同文件                                                                 |
| `RendererChannel`    | `electron/renderer-channel.ts`       | `DesktopApplication`（经 rpc server 构造） | `desktop-runtime.ts`（跨模块胶水，见 §2.3）                            |
| `MainWindow`         | `electron/main-window.ts`            | `DesktopConfig`、`RendererChannel`         | 同文件                                                                 |

规则：**Tag 归能力的定义方所有；Live Layer 归实现的提供方所有**（adapter 文件或组合根），内层模块永远不 import 外层实现。模块之间只允许 import 对方的 Tag 与接口类型。

### 2.2 `DesktopConfig`（新增）

把目前散在组合根里的宿主环境读取收拢为一个注入点：

```ts
class DesktopConfig extends Context.Service<
  DesktopConfig,
  {
    readonly isPackaged: boolean;
    readonly devUrl: string | undefined;
    readonly serverEntry: string;
    readonly token: string;
    readonly allowedOrigins: readonly string[];
  }
>()("desktop/DesktopConfig") {}
```

`DesktopConfigLive` 读取 `app.isPackaged`、`process.resourcesPath`、`ELECTRON_RENDERER_URL`、生成 token。这是当前唯一测不到的装配逻辑（`resolveServerEntry` 已是纯函数，保持）；service 化后其余 Layer 均可用假 config 组测。

### 2.3 组合根退化为 Layer 组合

`desktop-runtime.ts` 只保留三样东西：

1. **跨模块胶水 Layer**（组合根可以 import 一切，依赖规则不变）：

```ts
const RendererChannelLive = Layer.effect(
  RendererChannel,
  Effect.gen(function* () {
    const application = yield* DesktopApplication;
    const rpcContext = yield* Effect.context<never>();
    return makeRendererChannel(makeDesktopRpcServer(application, rpcContext).attach);
  }),
);
```

`rpcContext` 全量捕获的既有决策不变；rpc server 无独立 Tag——它只有 RendererChannel 一个消费者，且是纯构造（无 Scope、无状态），service 化它才是过度抽象。

2. **`AppProtocolLive`**：`registerAppProtocol(rendererRoot())` 包成无输出 Layer，`MainWindowLive` 依赖它保证注册先于窗口加载。
3. **`ManagedRuntime` + Electron lifecycle 外壳**：`startDesktopRuntime` 结构不变，删除 `DesktopRuntime` 包装，lifecycle 回调直接 `runtime.runFork(Effect.gen(... yield* MainWindow ...))`，启动路径 `Effect.result(contextEffect)` + `formatStartupFailure` 保持。

### 2.4 工厂保留，Layer 只是一层皮

`makeLocalBackend`、`makeDesktopApplication`、`makeMainWindow`、`makeRendererChannel`、`makeNodeBackendProcess` 全部保留原签名——它们仍是逻辑与单测的单位，现有测试一行不改。Layer 形如：

```ts
export const MainWindowLive = Layer.effect(
  MainWindow,
  Effect.gen(function* () {
    const config = yield* DesktopConfig;
    const channel = yield* RendererChannel;
    return yield* makeMainWindow({ devUrl: config.devUrl, connectRenderer: channel.connect });
  }),
);
```

### 2.5 明确不 service 化的

- 纯函数：`restartBackoff`、`formatStartupFailure`、`resolveAssetPath`、`resolveServerEntry`、`parseEnvironment`。
- 纯构造 wiring：`makeDesktopRpcServer`、`makeDesktopRouter`。
- `SpawnBackend` 保持 backend 模块自有的 port 类型（函数注入），不升级为 Tag——它的多态性已由 `local-backend-live` 与测试 fake 覆盖。

「service-per-file」仍然是反模式；本计划的判据是**已知的多消费者扇出**，不是文件对齐。

## 3. 行为保持声明

- 窗口仍在 backend ready 之后才打开：`MainWindowLive` 不依赖 `LocalBackend`，Layer 构建可并行，但 `ensureOpen` 仍由 lifecycle 在 `contextEffect` 完成后显式触发（P6.2 的 UX 决策不在本计划内）。
- pinned-port、重启退避、Retry、Quit、MessagePort 生命周期、`rpcContext` 全量捕获、日志 annotation：全部不动。
- `AGENTS.md` 更新两处：「Prefer explicit constructor parameters and plain capability values over a `Context.Service` for every file」改写为上面 §2.5 的判据；依赖方向一节补「模块间只 import Tag 与接口类型，Live Layer 归实现提供方」。

## 4. 实施步骤

1. 新增 `DesktopConfig` + `DesktopConfigLive` + 单测（fake `app`/env 注入）；
2. `LocalBackend` Tag 化 + `backend/local-backend-live.ts`（吸收 login-shell 环境解析与 `makeNodeBackendProcess` 装配）；
3. `DesktopApplication` Tag 化 + 同文件 Live；
4. `RendererChannel` Tag 化 + 组合根胶水 Layer；`MainWindow` Tag 化 + 同文件 Live + `AppProtocolLive`；
5. 重写 `desktop-runtime.ts` 为 Layer 组合，删除 `DesktopRuntime`；
6. `AGENTS.md` 与 `src/main/README.md` 同步；
7. 新增一个组合测试：以假 `DesktopConfig` + 假 `SpawnBackend` 构建完整 Layer 图（不含 Electron 窗口层），断言 `DesktopApplication.bootstrap` 可用——锁定 Layer 接线本身。

每步跑 `pnpm --filter desktop test && pnpm --filter desktop typecheck`；步骤 5 后补全验证矩阵：

```
pnpm --filter desktop build
pnpm --filter desktop e2e
pnpm check
pnpm test
```

关键回归项沿用 PR #102：MessagePort stream cancellation finalizer、renderer reload 换 port 不重启 backend、backend crash/recovery/Retry/Quit、`HTTPS_PROXY` 透传、packaged 启动路径（`electron/**` 与运行时路径有改动，按 AGENTS.md 要求做一次 unpacked 打包冒烟）。

## 5. 预估

约 6–8 个文件、±350 行,一个 PR。全部为结构迁移,无行为变化;失败模式集中在 Layer 依赖方向写反(typecheck 即暴露)与启动时序(e2e 覆盖)。
