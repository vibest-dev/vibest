# UI 层 harness 选择设计（选 agent + 模型 + 权限档）

> 状态：2026-07-21 设计定案，等待实现。分支 `feat/support-codex-pi`。
>
> 前置：[harness 权限能力协商设计](./harness-permission-capability-design.md)（`permissionModes` 的 harness 级协商已定案并落地）。本文在其上补齐 **model 维度**与**前端选择面**，并把三家 adapter 已注册但 UI 只能开 claude-code 会话的断层补上。
>
> 被否决的方案不逐条记录，只在关键处保留「为什么不」——这些地方后来者最容易走回头路。

## 1. 现状与断层

服务端三家 adapter（`claude-code` / `codex` / `pi`）已全部注册进 `HarnessAgentRegistry`（`packages/server/src/rpc/runtime.ts`），`harness.negotiate` 一次性返回每家的 `{ id, name, available, reason, capabilities }`。transcript 渲染也已按 harness 分支（`tool-part.tsx`，claude-code / codex 有专用渲染器，pi 走通用兜底）。

断层全在 UI：

| 位置                                    | 现状                                                     |
| --------------------------------------- | -------------------------------------------------------- |
| `routes/draft.tsx`                      | `harnessAgentId: "claude-code"` 硬编码，无选择器         |
| `components/chat/model-select.tsx`      | 模型列表写死 `opus` / `sonnet`                           |
| `draft.tsx` / `chat-input-composer.tsx` | placeholder 写死 `"Ask Claude Code anything..."`         |
| `chat-session-context.tsx`              | 会话内 model / permission 初值写死 `"sonnet"` / `"full"` |

且三家能力并不对称：codex 的 `setModel` 是 no-op、`pi` 没有权限协议、codex/pi 的 `checkAvailability` 写死 `true`（没装 CLI 也报可用）。

## 2. 核心原则

**所有 harness 差异收进 negotiate 返回的 capabilities，UI 只根据「字段在不在」决定渲染什么。**

UI 中唯一保留的 harness 字面量是首次进 draft 的默认值 `"claude-code"`。

**控件三态规则**（model / permission 共用）：

| capabilities 状态 | UI                      | `session.create` |
| ----------------- | ----------------------- | ---------------- |
| 字段缺失          | 不渲染控件              | 不带该字段       |
| 字段存在          | 渲染，初值取 `default*` | 带用户选中的值   |

「不带字段」= 由 harness 用自己的配置默认（codex 读 `config.toml`，claude 读自身默认）。这条语义前后端一致，也是第 5 节 URL 状态设计的基础。

## 3. Contract 变更

`HarnessAgentCapabilities` 增加三个 optional 字段：`models`、`defaultModel`、`defaultPermissionMode`。

| 字段                    | claude-code                     | codex                    | pi  |
| ----------------------- | ------------------------------- | ------------------------ | --- |
| `permissionModes`       | plan / ask / acceptEdits / full | read-only / ask / full   | 无  |
| `defaultPermissionMode` | `full`                          | `ask`                    | 无  |
| `models`                | 探测所得                        | `model/list` 所得        | 无  |
| `defaultModel`          | `"default"`                     | `isDefault: true` 的那个 | 无  |

`models` 保持 `{ id, name? }`（与 `SessionCapabilities.models` 同形）。

`ChatModel = "opus" | "sonnet"` 退化为 `string`，与 `ChatPermissionMode` 一致——模型列表是运行时从服务端来的，前端不可能再有静态字面量类型。

### 3.1 为什么默认值由 harness 自己声明

早期方案是「取 `permissionModes` 数组第一项」。否决理由：那会让**显示顺序**与**默认值**两个正交的东西永久耦合，以后谁调顺序都会不小心改掉默认值。且两家的「最宽松档」危险程度不同——codex 的 `full` 映射到 `approvalPolicy: "never"` + `sandboxPolicy: dangerFullAccess`（连沙箱都关），比 claude-code 的 `bypassPermissions` 更狠，不该和 claude-code 取同一个默认。**默认值的不对称正是这个字段存在的理由。**

同理，`defaultModel` 不取列表第一项：两家都有权威的默认信号（claude-code 的 `default` 条目、codex `Model.isDefault`），用数组顺序赌是把明确信息降级。

### 3.2 v1 不做：reasoning effort

claude-code 和 codex **都**有 effort 维度（前者 `supportsEffort` + `low/medium/high/xhigh/max`，后者 `supportedReasoningEfforts` 多一档 `ultra`），所以它不是 codex 特例。不做的理由是**范围控制**：它需要第二个控件，且取值集合依模型而异（claude 的 haiku 就没有 effort），两个下拉之间要联动 derive，是一块独立的状态设计。

`models` 现在的 `{ id, name? }` 将来加 optional 的 `efforts` / `defaultEffort` 即可，对 wire contract 是零破坏变更。

## 4. 探测（negotiate 时，server 端）

两家的模型列表都**不写死**——列表随账号、套餐、CLI 版本变化，写死必然腐烂。

### 4.1 探测方式

- **claude-code**：`maxTurns: 0` + 永不 yield 的 prompt generator，调 `query.supportedModels()`。
- **codex**：`initialize` → `model/list`。不传 `includeHidden`（服务端已默认排除 `hidden` 模型，与 codex 自身 picker 行为一致）。

claude-code 探测的副作用已实测确认：`~/.claude` 整棵树零文件改动，**不产生 session 记录、不污染 `--resume` 列表**。唯一副作用是触发一次 `SessionStart` hook——用户 hook 里有重活的话每次 negotiate 会白跑一遍，需在代码注释里点明。

### 4.2 执行顺序与保险

`harness.negotiate` 在 root route loader 里被 await（`__root.tsx`），negotiate 未 settle 前不渲染任何路由（期间显示 `router.tsx` 配的 `defaultPendingComponent`）。接入探测后，「刷新页面」= 等两个 CLI 进程起来，因此必须让等待有界：

1. **`checkAvailability` 先跑，不可用直接跳过 models 探测**。没装 codex 的机器（CI、多数用户）是**瞬时**返回不可用，不白等超时。
2. **并发**：`packages/server/src/rpc/harness.ts` 的 `Effect.forEach` 目前没传 `concurrency`，是串行的；改为 `concurrency: "unbounded"`，等待 ≈ 最慢一家。
3. **每家单独超时**（~5s），超时/失败按 §4.3 降级。超时只在「装了但卡住」这种真异常时才生效。
4. **codex/pi 的 `checkAvailability` 真实化**：从写死的 `true` 改成真实探测（PATH 上找可执行文件；codex 那次 `model/list` 调用成功与否本身就是最真实的信号）。否则 UI 的置灰态是死代码，会一直宣称 Codex 可用直到用户建会话时炸在 spawn 上。

**保持一次性 negotiate**（不拆成「静态部分 + 惰性 models」两段）：`models` 与 `defaultModel` 是同一次探测的产物，拆开后 default 属于哪一段都尴尬，且会把「capabilities 是一份原子快照」变成两份可能不同步的数据。

### 4.3 缓存：成功缓存，失败不缓存

惰性触发（首次 negotiate），成功结果缓存到进程结束；**失败不缓存**。

失败不缓存是硬要求：一次瞬时故障（`claude login` 过期、codex refresh token 失效）若被缓存，这个 server 进程**余生**都会认为该 harness 没有模型，用户必须重启 server 才能恢复。重新登录后刷新页面即恢复，才是符合直觉的行为。

## 5. UI

### 5.1 选择面与生命周期

**harness 在会话创建时固定，之后不可更改**——它是 `SessionRef` 的组成部分（`projectId` + `harnessAgentId` + `sessionId`），三家的原生 session id、transcript 格式、权限模型都不互通，「跨 harness 续接」不是一个有意义的概念。

- **draft**：`harness → model → permission` 三个同构下拉。顺序反映依赖方向——后两者的取值集合由 harness 决定。
- **会话内**：harness 显示为**静态 badge**（占 draft 上 harness 下拉的同一位置，视觉连续）。刻意不用禁用态下拉：禁用在交互语义上表达「现在不能改」，暗示某些条件下能改；静态 badge 才是诚实的。
- **首次默认**：硬编码 `claude-code`，不记忆上次选择。
- **不可用的 harness**：列出但置灰 + 显示 `reason`（不是隐藏）。隐藏会让用户面对「怎么没有 Codex」而无从下手；`"Codex was not found on PATH"` 是可操作的。
- **placeholder**：`"Ask {harness.name} anything..."`，draft 与 composer 两处。

### 5.2 draft 的配置状态：URL search params

三个值全部走 URL search params + TanStack Router 的 `validateSearch`：

**用户没显式选过的项不写进 URL**，渲染时从 capabilities derive 默认值。切 harness 就是一次 `navigate({ search: { harness: next } })`，`model` / `permission` 两个 key 自然消失 → 值自动回到新 harness 的默认。

**「重置」退化成「不写这个参数」——没有 `useState`、没有 `useEffect`、没有任何重置代码。** 附赠可分享、可前进后退、刷新保持。

更重要的是它与服务端语义对齐：URL 里没有 `model` 参数 = `session.create` 不带 `model` = 用 harness 默认（§2 的三态规则）。

被否决的几类做法及原因：

- `useState` + `useEffect` 监听 harness 变化后重置：会多渲染一帧，那一帧下拉的值不在选项集合里。
- 父组件持有 state + 在 `onChange` 里显式重置：能工作，但「重置」作为一段必须被维护的逻辑始终存在。
- 「draft 即 session」（进 draft 就建真 session，配置状态归服务端）：`SessionService.create` 会立刻 spawn harness 进程**并落盘**，切一次 harness 就多一个进程和一条垃圾会话。

### 5.3 会话内控件初值

从写死的 `"sonnet"` / `"full"` 改成该 harness 的 `defaultModel` / `defaultPermissionMode`。

这是**止血，不是修复**。真正的问题在 §7：会话配置没有持久化。但改完这一步至少保证「显示的值一定在选项集合内、一定合法」——否则本轮改动会把一个隐蔽缺陷变成硬故障（刷新一个 codex 会话，model 下拉拿着 `"sonnet"` 去 codex 列表里找，根本不存在）。**这是我们新引入的故障，必须由本轮负责。**

## 6. 测试

`apps/desktop/e2e/` 的 Playwright 靠 `tools/testing/fake-claude.mjs` 假扮 claude 二进制。探测接进 negotiate 后，e2e 每次启动都会走这条路。

- **fake-claude 补 `supported-models` 响应**——否则 negotiate 要等到超时才降级。
- **codex / pi 在 CI 上如实不可用**：没装就是没装，`checkAvailability` 前置短路使其瞬时返回，不拖慢 e2e。
- **不在 e2e 环境关掉探测**：negotiate 是本轮改动最重的地方，把它从 e2e 里挖掉等于自废武功。
- **UI 只测纯逻辑**：search params ↔ 配置的解析/derive 抽成纯函数，按 `chat-transport.test.ts` 的风格测。**不引入 testing-library**——那是基础设施投资，一旦引入，后续所有 UI 改动的测试期待都被抬高。

## 7. 不做 / 另开 ticket

- **会话配置的持久化与恢复**。`packages/server/src/types/index.ts` 的 `Session` 只有 `version / projectId / harnessAgentId / harnessSessionId / createdAt`，不存 model / permissionMode，刷新后 UI 显示的是默认值而非实际值。真正的难点不是加两个字段，而是**恢复语义**：server 重启后 `resume` 要不要把权限模式重新推给 harness？harness 那边的原生 session 已带着自己的状态回来时以谁为准？需单独定案。本轮只做 §5.3 的止血。
- **reasoning effort 二级控件**（§3.2）。
- **引入 testing-library**（§6）。
- **sidebar 会话列表**：`app-sidebar.tsx` 目前是纯 mock（"no session.list endpoint yet"），与本轮无关。

## 8. 落地切分

每个 PR 一个想法，三个连着推——不要让 ① 悬空太久，否则新增的 capabilities 字段会成为没人消费的死数据。

1. **contract + 探测基建**：capabilities 三字段、两家探测、availability 真实化、并发/超时/缓存/短路、e2e 的 fake-claude 补 `supported-models`。
2. **codex model 打通**：与它的 `permissionMode` 完全同构——`Ref` 存值 + `agent.prompt` 加 model 参数 + `turn/start` 带 `TurnStartParams.model`。`applyInitialSessionConfig` 一行不用改（create 时的 `setModel` 写进 `Ref`，首个 turn 带上）。与 ① 无耦合，可并行。
   - 注意 `codex/adapter.ts` 现有注释称「codex 在 thread start 时固定模型、没有运行时切换」——**后半句是错的**，`TurnStartParams.model` 的文档写明 "Override the model for this turn and subsequent turns"。
   - 待定细节：codex 会话中途改模型要**下一个 turn 才生效**，与 claude-code 的即时生效不同，UI 是否提示留到 ② 落地时定。
3. **UI**：§5 全部。唯一有用户可见行为变化的 PR，出事可单独 revert 而不牵连服务端能力。
