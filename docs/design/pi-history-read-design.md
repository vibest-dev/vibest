# Pi 会话历史读取与 UIMessage 折叠设计（getMessages pi 专项）

> 状态：v1 设计定案，等待实现。2026-07-30 与用户逐问定案（grilling 会话），关键行为均对
> pi 0.80.7 活二进制实测过。范围是 **pi 专项**：`session.getMessages` 按 `harnessAgentId`
> 分派，pi 走本设计，claude-code / codex 维持 `UNSUPPORTED`（归 wayfinder ticket 10/11）。
>
> 相关 ADR：`docs/adr/0003-pi-history-role-segmentation.md`（分段规则与 steer 差异）。
>
> 2026-07-30 适配 #153「dissolve @vibest/harness into contract + server」：纯转换层
> 不再是独立包，落点改为 `packages/server/src/harness/pi/`；`ai` 已是 server 直接依赖。

## 1. 目标与范围

刷新 / 重开 `/session/<id>` 页面后，pi 会话能从 agent 原生存储读回已提交的对话历史并渲染，
替代现在的空态提示（`chat-transcript.tsx` "Past messages can't be replayed yet"）。

范围内：

- `packages/server/src/rpc/session.ts` `getMessages`：pi 分派到真实实现。
- server 侧 pi 历史读取：wire 契约不要求活跃；「要有会话」由
  `HarnessAgentSessionManager` 的幂等 `ensure` 满足（见 §3）。
- harness 侧 `SessionEntry[] → UIMessage[]` 纯折叠（见 §4）。
- 客户端拉 `getMessages` 填充 transcript（路由 loader 的 `resume` **保留不动**）。

范围外：

- claude-code / codex 的历史读（ticket 10/11）。
- `SessionSummary.historyAvailable` 的真实判定（仍恒 true，跨 harness 能力面归 10/11 后统一）。
- ticket 12 的完整三路径 reconcile。
- compaction / branch summary 的展示（本期跳过，见 §5 跳过表）。

## 2. Pi 历史读取途径盘点（定案依据）

**权威来源**：pi 自带官方文档（`node_modules/@earendil-works/pi-coding-agent/docs/`，
已安装 CLI 为 0.82.1）——`docs/rpc.md`（RPC 协议全集）、`docs/session-format.md`
（JSONL 格式 + SessionManager API）、`docs/sessions.md`；源码仓库
`github.com/earendil-works/pi-mono`。以下结论以官方文档为准，关键行为另经活二进制实测。

`get_entries` / `get_tree` 自 **0.80.3** 起提供（CHANGELOG），我们钉的 0.80.7 与用户
CLI 0.82.1 均具备。

| 途径                                                        | 形态                                                                                                                                                                                                                                                                                                                      | 结论                                                                                                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **RPC `get_entries {since?}`**（`pi --mode rpc`）           | `{ entries, leafId }`，entries 按 **append order**。官方文档原话："包含 **pre-compaction history and abandoned branches**"——即全集，当前分支须由我们从 `leafId` 沿 `parentId` 回溯重建。`leafId` 让客户端"一个来回就知道 active branch 是否移动"；`since` 是**跨客户端重启有效的持久游标**（id 不匹配则 `success:false`） | **采用**（manager ensure 出该 session 的进程后，走其既有 transport，见 §3）                                                                                                          |
| 进程内 `SessionManager`（包根导出，`open().getBranch()`）   | 叶→根当前分支，实测 0ms、无副作用                                                                                                                                                                                                                                                                                         | **否**：执行的是钉在 0.80.7 的包代码，而实际写盘的是用户安装的 pi CLI（当前 0.82.1）——**读写版本漂移**；且破坏「agent 一律作为外部进程驱动」的架构一致性。用户 2026-07-30 定案走 RPC |
| `SessionManager.buildContextEntries()`                      | compaction 裁剪后的 LLM context                                                                                                                                                                                                                                                                                           | context ≠ transcript，否                                                                                                                                                             |
| `SessionManager.buildSessionContext()` / RPC `get_messages` | `AgentMessage[]`，**无 entry id**                                                                                                                                                                                                                                                                                         | 断 messageId 不变量，否                                                                                                                                                              |
| 直读 JSONL（`~/.pi/agent/sessions/<编码 cwd>/*.jsonl`）     | 裸文件                                                                                                                                                                                                                                                                                                                    | 文件内无 leafId，分支无法自行判定；且 session 有 **v1/v2/v3 三版格式，v3 的迁移在 load 时由 pi 自己做**（session-format.md），裸解析要自带迁移。否                                   |
| `--export` / `export_html`、进程内跑 `AgentSession`         | HTML / 完整 runtime                                                                                                                                                                                                                                                                                                       | 不适用 / 过重                                                                                                                                                                        |

## 3. 分层与职责（server 侧）

**统一职责原则（用户 2026-07-30 定案）**：harness 层已有三个抽象，各管一件事，
`getMessages` 不得让任何一个越界——

| 抽象                         | 一句话职责                                                                                                                                                                 | `getMessages` 中的角色                                                                                                            |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `HarnessAgentAdapter`        | 进入一个 harness 的门：冷探测（availability / probe / getSessionInfo）与工厂（open / resume）                                                                              | **不动**——本期不加任何方法                                                                                                        |
| `HarnessAgentSession`        | 一个活会话能做什么：prompt / events / config / close                                                                                                                       | **加可选 `getMessages?`**——读自己的历史是活会话的能力                                                                             |
| `HarnessAgentSessionManager` | **活体状态唯一所有者**：实例三态守卫（active / inFlight / closing）+ 每会话投影（私有 `session-runtime.ts` 模块）；shape `open / ensure / get / close / status / snapshot` | 「读历史前要有会话」由它满足——**复用自己既有的幂等 `ensure`**，不新造任何机制                                                     |
| `HarnessAgentSessionService` | **对外 session 服务**（`harness/session-service.ts`）：SessionRef 词汇——身份翻译（私有 repository）、词汇校验、集合事件                                                    | **新增 `getMessages`**：`readChecked` → `manager.ensure` → `manager.get` → `session.getMessages?`，缺席则 `CapabilityUnsupported` |

> **命名注**（2026-08-01 第二轮重构后）：`session/` 目录已整体消亡——`SessionService`、
> `SessionRuntimeService`、`HarnessAgentSessionPort` 均不复存在。投影（原 runtime）
> 是 `manager` 的私有模块，元数据落盘（repository）是门面的私有模块，Router
> （`rpc/session.ts`）只做 projectId → cwd 解析与错误码映射。另有 pi npm 包自己的
> `SessionManager`（§2 途径表，pi 的 API，与前述无关）。本文行文用 `manager` 短指代
> `HarnessAgentSessionManager`。

pi 的进程需求（「每个会话恢复一个 pi 进程」定案）由此自然满足：`manager` ensure 出的
managed session 背后就是那个 pi 进程。PiAgent（`harness/pi/agent.ts`）保持傻：
`openSession` 仍然只被 `manager` 这**唯一调用方**触达，不需要自带去重（见 §3.3）。
不引入共享 reader、不引入短命读进程、**不引入任何新的进程生命周期**。

### 3.1 依赖关系图

**包依赖**（#153 之后 `@vibest/harness` 已不存在；本设计**不新增任何包依赖**）：

```
      @vibest/contract  ◄────────  @vibest/server
      叶子：谁都不得反向依赖它        全部运行时 + 全部转换（#153 併入）
      deps: ai · effect ·           deps: contract · ai ·
            @orpc/contract                @earendil-works/pi-coding-agent
      SessionMessages 定义处               （钉 0.80.7，type-only：仅
                                          pi/protocol.ts、pi/tools.ts
                                          import type）· effect · …
```

原「harness 包纯 / browser-safe」的**包级**边界随 #153 消失；纯转换的约束降级为
**函数级纪律**（`history.ts` 纯同步、不碰进程/文件/Effect），靠签名与测试维持，
不再靠包图强制。

**模块依赖与类型流**（`↓` 是「依赖 / 调用」方向，右栏是**穿过该边界的类型**）：

```
rpc/session.ts  getMessages                                  [改] 范围闸门 + 错误映射
  │   ref.harnessAgentId ≠ "pi" → UNSUPPORTED（范围 A 定案；ticket 10/11 拆闸）
  │   projects.findById(ref.projectId) → cwd                  [已有]（同 resume 的既有路径）
  │                                              入 (SessionRef, cwd)
  ▼                                              出 ReadonlyArray<UIMessage>
harness/session-service.ts                                   [新增] 对外编排
  │   HarnessAgentSessionService.getMessages(ref, cwd)
  │   ① readChecked(ref) → 元数据（harnessSessionId）          [已有]
  │   ② manager.ensure({ sessionId, harnessAgentId, cwd }, ref) [已有] 三态幂等
  │   ③ manager.get(sessionId) → session                      [已有]
  │   ④ session.getMessages 缺席 → CapabilityUnsupported
  │   ⑤ manager.snapshot(ref) 裁 active turn（尽力而为，失败不裁）
  │   （manager = harness/session-manager.ts，本设计不改它）
  ▼
harness/adapter.ts  HarnessAgentSession.getMessages?         [新增] 会话的可选能力
  │                                              ┈┈┈ 归一化边界 ┈┈┈
  ▼
harness/pi/adapter.ts  makeSession 内实现                     [新增] 归一化层
  │   └─→ harness/pi/history.ts                              [新增] 纯函数（与 transform.ts 同目录）
  │         entriesToUIMessages(entries, leafId) → PiUIMessage[]
  │         不碰进程 / 文件 / Effect（§4）
  │   SessionEntry[] 到此为止，不再上行
  │                                              入 SessionEntry[] + leafId
  ▼
harness/pi/agent.ts  session.getEntries(sessionId)           [新增] 纯协议，**无 spawn**
  │   getSession(sessionId) 查表（manager 已 ensure，必命中）
  │   transport.command({ type: "get_entries" })
  ▼
harness/pi/transport.ts                                      [已有] 该 session 的 pi 子进程
```

`agent.ts` 只说 pi 的话（查表 + 发命令，返回 `SessionEntry[]`），`adapter.ts` 是归一化层
（调 §4 的纯函数折成 `UIMessage[]`）——与 `getSessionInfo` 在 adapter 里把原生数据折成
`SessionInfoResult` 同构。「要有进程」不出现在这两层的任何一层：`manager` ensure
完之前，调用根本到不了这里。

**三条不存在的边**（依赖审查的价值多半在负空间）：

```
rpc/*               ─╳→  harness/<agent>/*     Router 只见门面（与 registry 的
                                               list/probe 路由），不见 adapter
harness/pi/*        ─╳→  门面 / manager 之上     不知道 SessionRef 语义 / 元数据 / 投影
harness/pi/*        ─╳→  「生命周期」            spawn/去重/关闭全归 manager；
                                               PiAgent 不自造第二套
```

### 3.2 各层职责与硬规则

| 层                                    | 负责                                                        | **不知道**                                          |
| ------------------------------------- | ----------------------------------------------------------- | --------------------------------------------------- |
| Router（`rpc/session.ts`）            | 范围闸门、projectId → cwd 解析、错误码映射                  | native id、entry 结构、进程                         |
| `HarnessAgentSessionService`          | ref ↔ native id 翻译、ensure→get→能力编排、裁 active turn   | entry 结构、折叠规则、生命周期状态                  |
| `HarnessAgentSessionManager`          | 活体状态（三态守卫 + 投影、open/ensure/get/close/snapshot） | entry 结构、折叠规则、wire 词汇                     |
| pi session + agent（`harness/pi/`）   | 发 `get_entries`、调折叠、产出 `UIMessage[]`                | server 的 `SessionRef` 语义、**自己怎么被开出来的** |
| 纯折叠函数（`harness/pi/history.ts`） | 分支回溯 + 折叠                                             | 进程、文件、Effect                                  |

两条硬规则，都是既有约定的延续：

- **`SessionEntry` 不得穿出归一化边界。** 门面拿到的必须是归一化的 `UIMessage[]`，
  entry 结构在 `harness/pi/` 内部消化——照抄 `getSessionInfo` 返回
  `SessionInfoResult` 而非 agent 原生数据的做法（`adapter.ts`）。
- **active turn 的裁剪归门面，不归 adapter。** 「哪个 turn 在进行中」只有 manager 的
  投影知道（`manager.snapshot`）；adapter 看不见也不该看见。会话投影缺席时
  `snapshot` 失败 → 不裁（本就没有进行中的 turn），用 `Effect.catch` 降级成空，
  **不要**让它污染 `getMessages` 的错误通道。

类型上没有额外约束（#153 后 server 直接依赖 `ai`，`PiUIMessage` 本就定义在
`harness/pi/ui-message.ts` 里）：门面层沿用 contract 的
`SessionMessages["messages"]`（同 `session-runtime.ts` `WireChunk` 的取法）。实现时确认
`PiUIMessage[]`（带 `PiMetadata`/`PiTools` 泛型）到裸 `UIMessage[]` 的可赋值性即可；
chunk 侧已有同样的跨越（`PiUIMessageChunk` → `SessionMessageChunkEvent["chunk"]`），
照其办法办。

### 3.3 「要有会话」归 manager，「要有进程」是 pi 的既有事实

wire 契约仍是冷的：`contract/src/session.ts:45-49` 把 `getMessages` 归在
**history / index 组**，同组的 `list` / `rename` / `delete` / `resolveRef` 没有一个要求活跃；
客户端与 Router 都不需要知道「pi 的历史要先有进程」。这两条早先定案不变。

变的是 ensure 的归属。「读历史前要有一个 managed session」是**生命周期问题**，而生命周期
在这套抽象里只有一个权威——`HarnessAgentSessionManager` 的三态守卫
（`harness/session-manager.ts`：active 命中早退 / inFlight 等 Deferred / closing 排队后
重试）。所以门面的 `getMessages` 第一步就是调 **manager 既有的 `ensure`**，不新造原语。
对 pi 而言 ensure = 开出那个进程（一 session 一子进程的既有行为），于是「每个会话一个
pi 进程」定案自然达成；随后的 `prompt` 走 `getSession` 命中同一条记录，正好复用。

**为什么 PiAgent 不能自己 get-or-create**（上一版方案，撤回）：`openSession`
（`agent.ts:300`）是无条件新建 + **盲写覆盖**（`:339` `new Map(current).set(...)`），
它今天不泄漏进程，靠的是一个隐式不变量——**manager 是它唯一的调用方**，且其
三态守卫保证对每个 sessionId 只调一次。让 `getEntries` 绕过 manager 直接
spawn，就是给 `openSession` 开第二扇门：冷读先开进程 A、resume 后到再开进程 B，A 被
挤出 map 后无人能 close（其 scope fork 自 `ownerScope`，活到 agent 关停）——一次调用
泄漏 169MB。补救办法是把去重下沉进 PiAgent，但那等于 pi 协议层自己长出第二套生命周期
机制，与 manager 职责重复。**正解是不开第二扇门**：所有进入 `openSession`
的路径都过 manager，单调用方不变量从「隐式」变成「架构规则」
（§3.1 第三条不存在的边）。

层层落定后各自的收益：

- Router：不做 ensure，不知道进程。只闸门、解析 cwd（`ProjectNotFound`）、映射错误码。
- 门面 `getMessages`：错误通道 = readChecked 的
  `SessionNotFound | SessionRefMismatch | StoreReadError` + `ResumeSessionError` +
  `CapabilityUnsupported | AgentOperationError | HarnessSessionNotFound`——resume 错误
  **存在但只到 RPC 映射为止**，按既有映射转 `NOT_FOUND` / `INTERNAL`，不进 wire 契约。
- `agent.ts` 的 `getEntries`：退化成纯协议——`getSession` 查表（manager
  保证命中）+ `transport.command`，**一行 spawn 代码都没有**。
- 客户端：只管调。loader 现有的 `resume`（`$sessionId.tsx:30`）保持不动——它先到，
  manager 的 ensure 就幂等命中；它没到，ensure 补上。两个入口一个权威，无顺序依赖。

### 3.4 能力可选性

`getMessages` 是 `HarnessAgentSession` 上的**可选方法**：pi 的 `makeSession` 实现，
claude-code / codex 的不实现。能力缺失用**既有的 `CapabilityUnsupported` 错误**
（`harness/errors.ts`）表达，由门面（`HarnessAgentSessionService`）在方法缺席时集中
抛出，RPC 层映射
`UNSUPPORTED`。「可选方法表示能力缺失」的先例是 `HarnessAgentAdapter.probeModels?`
（`adapter.ts:195`，注释「Absent for harnesses with no model catalogue (pi)」）。

**范围闸门仍在 RPC 层**（§1 的范围 A 定案）：`ref.harnessAgentId !== "pi"` 直接
`UNSUPPORTED`，不进门面。这一闸有个额外作用：门面的能力检查要先
ensure 才拿得到 session 实例，若放 claude-code / codex 进来，会为一个注定
`CapabilityUnsupported` 的调用白开一个会话。闸门保证本期只有 pi 走到门面；
ticket 10/11 落地时拆闸，其检查退居防御位。

不选另外三条路的理由：

- **必选方法 + 各 adapter 自己 fail `CapabilityUnsupported`**——`getCapabilities` 的错误
  通道里就写着 `CapabilityUnsupported`（`adapter.ts:111`），看着像先例。但三个 adapter
  **无一真的抛过它**（pi `adapter.ts:211` 与 codex `adapter.ts:316` 都是 `Effect.succeed`，
  claude-code `adapter.ts:300` 只抛 `AgentOperationError`）——这条错误分支目前是死的。
  照它办要给 claude-code / codex 各写一个「永远失败」的桩，ticket 10/11 上来就删。
  两种写法最终都落在 `CapabilityUnsupported`，可选与否只决定「谁抛」：门面
  集中一次，还是三个 adapter 各一次。故取前者。
- **`SessionCapabilities` 加 `supportsHistory`**（`contract/src/domain.ts:481`，已有
  `supportsResume`/`supportsSteering`/`supportsPermissions`）——`getCapabilities` 整条链
  目前是**休眠的**：只存在于 `adapter.ts` 与门面的委托里，**没有挂上
  port，也没有 RPC**。为本期需求去激活一个休眠面，成本大于收益。
- **adapter 级声明式布尔**（仿 `permissionModes` 的「plain values, not effects」）——
  等 `SessionSummary.historyAvailable` 要真实判定时，那才是它的正确归宿（不需要进程、
  不会失败）。本期 `historyAvailable` 明确不在范围内，故不提前引入。

### 3.5 其余定案要点

- **代价（明示）**：打开一个会话 = 一个 pi 进程 ≈ **169MB**（实测，pi 是 node 脚本，
  此为 Node 运行时底价）。N 个已打开会话 ≈ N×169MB。这是**当前 live 路径既有的行为**
  （`agent.ts:21`「one `pi --mode rpc` child per session」），本设计不改善也不恶化；
  进程经济性留给后续专项（见 §9）。
- 读用**用户安装的 pi CLI**——写盘与读盘是同一个二进制，无版本漂移；
  `@earendil-works/pi-coding-agent@0.80.7` 维持 type-only（#153 后钉在 server，
  仅 `pi/protocol.ts`、`pi/tools.ts` 两处 `import type`）。
- **不需要 id → 路径解析**：pi 进程按 `(sessionId, cwd)` 自己找到正确的文件，
  `get_entries` 直接就是它。glob 编码规则、`PI_*_DIR` 覆盖、`harnessSessionFile`
  元数据字段——**统统不需要**，这是本方案相对共享 reader 最大的简化。
- **session 不存在**：manager 的 ensure 走 resume，`openSession` 的握手（`get_state`，
  `agent.ts:313`）会失败，经既有 resume 失败路径上抛。`getMessages` 不自己判定，
  也不需要额外的存在性检查。
- **非只读风险留档**：v1/v2 格式的旧 session 被 pi 加载时会**原地重写文件**完成 v3
  迁移。我们创建的 session 都是 v3，不受影响；读用户手工创建的老 session 会触发一次
  改写。这是 resume 本身的行为，不是历史读引入的。

### 3.6 JSONL 分帧合规（官方警告）

`docs/rpc.md` 明确要求：**只按 LF 切分，不得使用把 U+2028/U+2029 也当换行的通用
行读取器**——文档点名 Node `readline` 不合规（这两个码位在 JSON 字符串里合法）。
可选地容忍并剥掉行尾 `\r`。

现状复核：`packages/server/src/harness/pi/transport.ts:219` 用的是 Effect
`Stream.splitLines`，其实现只在 `\r` / `\n` 上切（`effect/dist/Channel.js` 的
`splitLinesArray`），**不碰 U+2028/U+2029 → 合规**。裸 `\r` 不会出现在
`JSON.stringify` 产物的字符串内部（被转义成 `\\r`），故 `\r` 分支也无风险。
**不要"优化"成 `readline`**——这是官方点名的坑。

## 4. 折叠规则：`entriesToUIMessages`（纯转换）

`packages/server/src/harness/pi/history.ts`（与 `transform.ts` 同目录），
纯同步函数 `entriesToUIMessages(entries, leafId, sessionId)`（落地时加了第三参：
metadata.sessionId 与实时 `start` chunk 的 `messageMetadata` 同源，纯函数自己拿不到），
直接构造最终形态的 `PiUIMessage[]`。**不经过 UIMessageChunk 回放**——chunk 是流式线格式，
历史是已完结数据，生产路径不引入流机器（用户 2026-07-30 明确否决 chunk 回放方案；
reducer 只在对拍测试里当裁判，见 §7）。

0. **分支重建**：`get_entries` 返回的是全集，先从 `leafId` 沿 `parentId` 回溯到根、
   反转得到当前分支，再折叠。`leafId` 为 null 或链断裂 → 空历史（fork/损坏防御）。
1. **分段按 role**：`user` message entry 开启新消息；其后连续的 `assistant` / `toolResult`
   entry 折成**一条** assistant 消息，直到下一个 `user` entry。不依赖 `stopReason`
   枚举（`toolUse`/`stop` 之外还有 `error`/`aborted`，且 auto-retry 会让一个 run 内
   出现多个终止性 stopReason）。
2. **messageId**：assistant 消息取该段**首条 assistant entry 的 id**；user 消息取
   user entry 的 id。pi entry id 跨读取稳定（实测），供刷新后 reconcile 比对。
3. **排除 active turn**（契约要求）：runtime 有进行中 turn 时，丢弃最后一个 user 段。
4. steer / follow_up 中途注入的 user entry 自然开启新段（实测两者落盘链相同）。
   由此产生的实时/历史分段差异见 ADR 0003。

## 5. 逐字段映射（数据保全）

| pi 历史                                                                                                                  | UIMessage part / 位置                                                     | 说明                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| user `content[].text`                                                                                                    | `{ type: "text", text }`                                                  |                                                                                                                                                                                                                                                                                                |
| user `content[].image`                                                                                                   | file part（带 mediaType）                                                 | 图片不丢                                                                                                                                                                                                                                                                                       |
| assistant `text`                                                                                                         | `{ type: "text", text, state: "done" }`                                   | `textSignature` 入 part 的 providerMetadata                                                                                                                                                                                                                                                    |
| assistant `thinking` 非空                                                                                                | `{ type: "reasoning", text, state: "done" }`                              | Anthropic 系明文可还原                                                                                                                                                                                                                                                                         |
| assistant `thinking` 空（openai-responses 加密）                                                                         | **不发**                                                                  | 唯一不可还原损失（pi 落盘即无明文）；不发假空块                                                                                                                                                                                                                                                |
| `toolCall` + 配对 `toolResult`                                                                                           | `tool-<name>` part，`state: "output-available"`，`providerExecuted: true` | **output 包回 `{ content, details }`** 与实时 `tool_execution_end.result` 同形（落地勘误：实测 `result` 里没有 `isError`——它是事件的兄弟字段，part 的 state 已编码它，对拍要求逐字段同形）；dynamic 工具判定复用 `isDynamicPiTool` → `dynamic-tool` part；`toolCallId` 含 `\|` 为复合 id，不拆 |
| `toolResult.isError === true`                                                                                            | 同上但 `state: "output-error"`，errorText 取 text 块拼接                  | 与 `transform.ts` `toolResultText` 同源                                                                                                                                                                                                                                                        |
| 孤儿 `toolCall`（无 result，run 中断）                                                                                   | `state: "input-available"`                                                | 未完成调用不丢                                                                                                                                                                                                                                                                                 |
| assistant `usage` / `cost` / `model` / `provider` / `stopReason`                                                         | `message.metadata`（`PiMetadata` 加可选字段）                             | 历史比实时富，对拍允许此不对称                                                                                                                                                                                                                                                                 |
| entry：`model_change` / `thinking_level_change` / `custom` / `label` / `session_info`                                    | 跳过                                                                      | `custom` 是扩展状态，官方明示不进 LLM context                                                                                                                                                                                                                                                  |
| entry：`compaction` / `branch_summary`；message role：`bashExecution` / `custom` / `branchSummary` / `compactionSummary` | 本期跳过                                                                  | 将来可作 `data-*` part，单独立项                                                                                                                                                                                                                                                               |
| entry：`custom_message`（`display: true`）                                                                               | 本期跳过（**已知缺口**）                                                  | 官方定义为「扩展注入且**参与 LLM context**、`display:true` 时在 TUI 有独立样式」的消息——属于用户可见对话的一部分，跳过是可感知的损失。补齐归后续 ticket                                                                                                                                        |

跳过表用 `satisfies` 穷举（同 `transform.ts:176` 的手法）：pi 新增 entry 类型 / role 时
typecheck 失败，强制显式路由或列入跳过。

part 的精确字段形状以 `ai@7.0.31` 类型为准；`PiUIMessage` 已带 `PiTools` 泛型，拼错字段
过不了 typecheck（server 开启 `test.typecheck`）。

## 6. 已知损失与两侧差异（均为接受项）

1. **加密 thinking 不可还原**：openai-responses 的推理只存加密 blob。刷新后该段
   reasoning 消失。
2. **steer 分段差异**：实时流把一次 agent run（含 steer 注入）折成一条 assistant 消息；
   历史按 user entry 分段，同一对话刷新后 3 条 → 4 条。历史侧是更准确的记录。详见 ADR 0003。
   注意：map.md 将 steer 列为 out of scope（"现状 TurnAlreadyRunning 拒绝"），但
   `packages/server/src/harness/pi/agent.ts:421` 实际已实现 steer——文档落后于代码。
3. **历史 metadata 更富**：usage/cost/model 只有历史侧有。

### 6.1 注入消息的投递语义（官方定义，影响分段判读）

- `steer`：在**当前 assistant turn 执行完工具调用之后、下一次 LLM 调用之前**投递。
- `follow_up`：在 agent 再无工具调用与 steering 消息时才投递；实现上是在 outer loop
  `continue`、**在 `agent_end` 事件之前**投递，因此它延长同一次 runAgent 而不开启新 run。
  → 任何按 `agent_end` 切分 turn 的集成都会切错；我们的 transform 用
  `agent_settled` 收尾（`transform.ts:164`），是对的，勿改成 `agent_end`。
- `steeringMode` / `followUpMode` 默认均为 **`one-at-a-time`**：每个边界只投递**一条**
  排队消息。用户在一个 turn 内连发三条，后两条会继续排队而非一次性注入——这是
  live 路径的既有行为，历史侧只是如实反映（每条注入各自成段）。

## 7. 测试策略

- 对拍测试放 `packages/server/test/harness/pi/`（`history.test.ts`，与既有
  `transform.test.ts` 同目录）：同一场会话的实时事件流经
  `createPiTransform` + `readUIMessageStream`（reducer 仅测试内使用）折出
  「实时侧最终 UIMessage」，与 `entriesToUIMessages` 的产出逐 part 比对。
  **断言范围限无 steer 的会话**（§6.2 的差异是设计而非缺陷）。
- 覆盖：单轮纯文本、thinking（明文/加密两态）、工具调用（成功/isError/孤儿）、
  多轮、steer 会话（断言历史侧 4 条的正确形状，不与实时比对）。
- 端到端：verify skill 流程——发消息 → 刷新 → 断言 transcript 重现。

## 8. 落点清单

按 §3 的分层，自下而上：

| 层           | 文件                                                    | 动作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 纯转换       | `packages/server/src/harness/pi/history.ts`             | **新增** `entriesToUIMessages(entries, leafId)`：分支回溯 + 折叠（§4、§5）                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 纯转换       | `packages/server/src/harness/pi/ui-message.ts`          | `PiMetadata` 加可选 usage / model / stopReason 字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| pi 协议      | `packages/server/src/harness/pi/agent.ts`               | **新增** `session.getEntries(sessionId)`：`getSession` 查表 + `transport.command({ type: "get_entries" })`，返回 `{ entries, leafId }`。**无 spawn**——manager 保证会话已活                                                                                                                                                                                                                                                                                                                                                              |
| pi 归一化    | `packages/server/src/harness/pi/adapter.ts`             | 在 **`makeSession` 返回的 session 对象**上实现 `getMessages`：调 `agent.session.getEntries` → 调 §4 纯函数 → **`UIMessage[]`**（`SessionEntry` 到此为止）                                                                                                                                                                                                                                                                                                                                                                               |
| session 契约 | `packages/server/src/harness/adapter.ts`                | `HarnessAgentSession` 加**可选** `getMessages`（可选=能力缺失，同 `probeModels?:195` 的写法；claude-code / codex 不实现）。`HarnessAgentAdapter` **不动**                                                                                                                                                                                                                                                                                                                                                                               |
| 门面         | `packages/server/src/harness/session-service.ts`        | `HarnessAgentSessionService` **新增** `getMessages(ref, cwd)`：`readChecked(ref)` → `manager.ensure({sessionId, harnessAgentId, cwd}, ref)` → `manager.get(sessionId)` → `session.getMessages`（方法缺席时 `Effect.fail(new CapabilityUnsupported(...))`）→ 依 `manager.snapshot(ref)` 裁 active turn（投影缺席则 `Effect.catch` 降级成不裁）。`harness/session-manager.ts` **不改**——ensure/get/snapshot 已存在。**顺带**更新 `list()` 里「History isn't served yet regardless (getMessages is UNSUPPORTED)」的注释——pi 落地后该句失效 |
| RPC          | `packages/server/src/rpc/session.ts`                    | `getMessages`：`ref.harnessAgentId !== "pi"` → `UNSUPPORTED`（范围闸门，§3.4）；pi 则 `projects.findById(ref.projectId)` 取 cwd（同 `resume` 的既有路径）→ 门面 `getMessages(ref, project.path)` + 错误映射                                                                                                                                                                                                                                                                                                                             |
| 客户端       | `apps/app/src/routes/session/$sessionId.tsx` 或 chat 层 | 拉 `getMessages` 填充 transcript（loader 的 `resume` 保持不动）                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 客户端       | `apps/app/src/components/chat/chat-transcript.tsx`      | 有历史时不再显示空态提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 文档         | `docs/wayfinder/session-streaming-refactor/map.md`      | steer 现状勘误（out of scope 记载与代码不符）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**不需要**（相比先前几版）：`harness/pi/history.ts` 编排层、`switch_session` 与串行
队列、空闲 TTL、`harnessSessionFile` 元数据字段、id→路径 glob 与 `PI_*_DIR` 处理、
客户端的 `SESSION_NOT_ACTIVE` 重试、loader 去 resume。

## 9. 否决方案存档

> 存档按否决当时的拓扑行文：文中的 `SessionService`、`SessionRuntimeService`、
> `port` / `port.ts:38` 均指 2026-08-01 重构前的旧结构（现已消亡，见 §3 命名注）。
> 结论不受影响——当时反对的理由在新拓扑下同样成立，只是承担者换了名字。

- **跨 harness 能力面先行**（port 加 `getMessages` + `unsupported` 档）——用户选 pi 专项，
  能力面归 ticket 10/11 时再抽象。
- **进程内 `SessionManager` 读盘**（曾短暂采纳）——0ms 且无副作用，但执行钉死的
  0.80.7 包代码去读用户 CLI（0.82.1）写的文件，读写版本漂移；且 vibest 驱动 agent
  一律走外部进程，进程内加载 pi runtime 是架构特例。用户 2026-07-30 定案改走 RPC。
  **须知这与官方建议相反**：`docs/rpc.md` 开篇建议 Node/TS 应用「直接用
  `AgentSession` 而不是 spawn 子进程」。该建议隐含「pi 是你应用的依赖」；vibest 的
  前提不同——我们驱动的是**用户自己安装的 pi CLI**，读写必须同一二进制，故不适用。
- **每次冷读起短命进程**（曾短暂采纳）——每读一次付 170MB 内存尖峰 + ~400ms 启动。
  用户 2026-07-30 否决。
- **全局共享 reader**（曾短暂采纳，实测可行：`switch_session` 跨 session-dir 切换
  正确、热读 4–38ms、`--no-extensions` 下零写入、内存上界 1×169MB）——被用户
  2026-07-30 定案否决，理由是**先要简单**：它引入一套全新的进程生命周期
  （懒启动 / 串行队列 / 空闲 TTL）、一个元数据字段、一条 id→路径解析链路，
  以及客户端的 `SESSION_NOT_ACTIVE` 重试。当进程经济性成为真问题时，
  这套方案连同实测数据都在这里，可直接取用。
- **「发信息才 resume」**（曾定案，同批否决）——它依赖「无进程也能读历史」，
  而 pi 读历史就是打开进程，前提不成立。路由 loader 的无条件 `resume` 因此保留。
  代价是打开会话即 169MB，与今天行为一致。
- **「服务端严格 `SESSION_NOT_ACTIVE`，由客户端 resume 后重试」**（曾定案，2026-07-30
  推翻）——与 `prompt`/`getSnapshot` 的语义看齐是它唯一的优点，代价是把 **pi 的实现
  约束**写进跨 harness 的 wire 契约，逼每个客户端都知道「pi 的历史要先 resume」；且
  `getMessages` 会成为 contract history/index 组里唯一要求活跃的方法。
- **`SessionService.getMessages` 内部 `ensureActive`（= 无条件 `resume(ref)`）**
  （曾定案，2026-07-30 推翻）——把 pi 的进程需求提到了所有 harness 的公共编排层。
  ensure 属于生命周期，生命周期的唯一权威是 harness 层的 manager，不是
  `SessionService`。**顺带作废**的两条推理：`SessionRuntimeService.start` 幂等性、
  `SessionRuntimeService.status` 对 crashed runtime 仍成功的陷阱——`SessionService`
  不再碰这两者（manager 的 ensure 用的是自己的三态守卫，与投影层无关）。
- **`getMessages` 挂在 `HarnessAgentAdapter` 上（冷读接口）+ pi 内部自行保障进程**
  （曾定案，2026-07-30 同日推翻）——表面理由充分：`getSessionInfo` 是「without opening
  it」的邻居先例，claude-code / codex 将来冷读不付进程账。真正的代价在 pi 侧：adapter
  级冷读意味着 `getEntries` 要能在无会话时自己 spawn，而 `openSession`（`agent.ts:300`,
  `:339` 盲写覆盖）不泄漏进程靠的是「manager 是唯一调用方」这个隐式不变量
  ——绕过它开第二扇门，冷读与 resume 反序即泄漏 169MB；补救（PiAgent 内置
  get-or-create 去重）又等于在协议层里长出第二套生命周期机制，与 manager
  的三态守卫职责重复。**统一职责定案**：抽象各归其位——`HarnessAgentSession` 管能力、
  `HarnessAgentSessionManager` 管生命周期、`HarnessAgentAdapter` 不动；ensure 复用
  manager 既有幂等原语，PiAgent 保持单调用方。claude-code / codex 的
  无进程冷读留给 ticket 10/11：届时若确需 adapter 级读法，再在门面里做
  「adapter 有冷读实现则用之、否则 ensure + session 能力」的分派——分派点不变。
- **adapter 返回 `{ entries, leafId }` 由上层折叠**（曾写入落点清单，同批修正）——
  会让 pi 的 `SessionEntry` 穿过 port 抵达 `SessionService`，违背 `port.ts:38`
  「never to the harness adapters directly」。改为 adapter 内部完成折叠、只吐
  `UIMessage[]`，与 `getSessionInfo` 返回 `SessionInfoResult` 同构。
- **每 session 常驻读进程（独立于 live 进程的第二个）**——一个 pi RPC 进程 169MB，
  且同一 session 文件会有两个进程。
  （观察留档：live 路径今天就是一 session 一常驻子进程，10 个会话 ≈ 1.7GB；
  共享 reader 模式或许也是 live 侧将来的收敛方向，不属本设计。）
- **chunk 回放构造历史**（entries → 合成 chunk → reducer）——流机器进生产路径，
  被用户否决；reducer 降级为对拍测试裁判。
- **按 `stopReason` 分段**——终止原因枚举不可穷尽（error/aborted/auto-retry），
  user entry 边界更硬。
- **`buildContextEntries` / `get_messages` 作数据源**——前者被 compaction 裁剪，
  后者无 entry id。
