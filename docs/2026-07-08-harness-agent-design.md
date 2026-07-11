# Harness Agent 运行时设计文档

> 配套架构图：[2026-07-09-harness-agent-overview.excalidraw](2026-07-09-harness-agent-overview.excalidraw)，用 excalidraw 打开后按 frame 分两块看——① 模块架构图（模块划分 + WS Server 结构）、② events 订阅时序图（§4.3 订阅/心跳/丢帧恢复/断线重连时序）

> 范围：覆盖 harness agent 运行时的核心能力域——`session`（会话生命周期与交互，核心模块）、`harness`（可用 agent adapter 信息）、`skill`（skills 安装与管理，暂不细化）、`provider`（模型/provider 配置，含自定义 provider）、`mcp`（MCP server 配置，暂不细化）、`fs`（文件读取/检索，只读）、`git`（只读 git 信息）、`project`（项目管理）、`pty`（伪终端会话管理，暂不细化）；不含任务看板、agent 执行器注册表、模型市场（可发现/浏览的第三方 provider 目录，跟"配置已有 provider"是两回事，见 §4.8）、通用应用配置等其他领域——"置顶会话""折叠分组""主题色"这类是纯 UI 本地状态，都不属于这套 headless runtime 该管的范围。
>
> 定位：vibest monorepo 内新增的一个 server 子包（`@vibest/server`），承载这套 harness agent 运行时模块，作为 vibest 内部的服务端模块交付，不作为对外发布的 SDK——服务端实现全部采用 Effect v4（`effect@^4`）：service 用 `Context` Tag + `Layer` 定义与装配、异步与错误用 `Effect<A, E, R>` 的类型化错误（`Data.TaggedError`）、资源生命周期用 `Scope`/finalizer、事件流用 `Stream`。客户端（vibest 自己的前端）和服务端之间用 **oRPC v2** 通信（不是 REST）：走 oRPC 的 WebSocket 适配器（`@orpc/server/websocket` 的 `RPCHandler`），在单条 WS 连接上多路复用地跑类型安全的 procedure 调用 + event iterator 事件流；oRPC procedure 用官方的 `@orpc/experimental-effect` 集成直接写成 Effect（`.effect(function* …)`），把 §5 的 Effect service 注入进 handler。鉴权对齐 OpenCode 的模式——默认不鉴权，可选 `Authorization: Basic`。

## 1. 目标与范围

目标是设计一套通用的 Harness Agent Client-Server 架构：服务端托管 agent harness 的运行时（session 生命周期 + fs/git/project 能力），客户端通过一条 WS 连接远程驱动它。服务端运行时落在 vibest 新增的 `packages/server`（`@vibest/server`）子包里，客户端访问层落在另一个新增的 `packages/client`（`@vibest/client`）子包里（见 §2）；两者都作为 vibest 内部子包交付，不作为对外发布的 SDK。

- 鉴权默认关闭；设置密码环境变量后要求 `Authorization: Basic <base64(user:pass)>`（在 WS 握手阶段校验）。

## 2. 子包结构

在 vibest monorepo 里新增两个子包承载这套 harness agent 运行时——`packages/server`（`@vibest/server`）放服务端运行时，`packages/client`（`@vibest/client`）放客户端访问层；由 vibest 自己的前端（web / side panel / devtools-client）通过一条 WS 连接消费。两者都是 vibest 内部子包，先不拆成对外发布的 SDK。

- **服务端运行时**：`packages/server`（`@vibest/server`）子包——session 生命周期 + fs/git/project 等能力，实现成一个 oRPC router、经 WS `RPCHandler` 暴露，本文档的主要设计对象（§4–§8）。
- **客户端访问**：`packages/client`（`@vibest/client`）子包——在 oRPC 客户端（`@orpc/client` + WebSocket link）上薄封装建连、事件订阅、断线重连（见 §3）；类型直接复用 `@vibest/server` 的 oRPC router 类型（`RouterClient`），独立于 `@vibest/server`，不放在服务端子包里，先不单独发布成 SDK。
- **React 状态层**：作为 vibest 内部模块（见 §9），依赖 `@vibest/client`，先不单独发布成 SDK 包。

## 3. 使用方式

核心用法——建连、挑一个可用的 harness agent、创建会话、发消息、订阅事件；完整方法列表见 §4。

```typescript
import { createHarnessClient } from '@vibest/client';

const client = createHarnessClient({
  url: 'ws://127.0.0.1:7001',
  // 可选：只有服务端设置了密码才需要传
  headers: { Authorization: `Basic ${Buffer.from('opencode:xxx').toString('base64')}` },
});

// 断线重连后没有历史事件回放，客户端只负责告诉你"该去补快照了"
client.on('reconnected', async () => {
  for (const sessionId of trackedSessionIds) {
    const snapshot = await client.session.getSnapshot(sessionId);
    // ...用 snapshot 覆盖本地状态
  }
});

// 挑一个可用的 harness agent，创建会话并发消息
const harnessAgents = await client.harness.list();
const { sessionId } = await client.session.create({ projectId, harnessAgentId: 'claude-code' });
await client.session.prompt(sessionId, { text: '帮我修一下登录 bug' });

// 订阅事件（oRPC event iterator；不传 sessionId 订阅所有会话）
for await (const event of client.session.subscribe()) {
  console.log(event.harnessAgentId, event.sessionId, event.type, event.payload);
}
```

## 4. API 模块

服务端把下面各模块实现成一个 oRPC router，经 oRPC 的 WebSocket 适配器（`@orpc/server/websocket` 的 `RPCHandler`）在单条 WS 连接上暴露；客户端用 `@orpc/client` 的 WS link 直接调用类型安全的 procedure（`client.session.create(...)` 等），事件订阅走 oRPC 的 event iterator（§4.3），都多路复用在这一条连接上。共十个模块（= oRPC router 的十个命名空间），按 §4.1–4.10 展开；其中 `harness`/`skill`/`session` 背后分别对应服务端内部的 `HarnessAgentRegistry`（§5.1）、`HarnessAgentSkillService`、`HarnessAgentSessionService`（§5.2）——oRPC 命名空间去掉了 `HarnessAgent` 前缀，内部实现类名不跟着改。

### 4.1 harness 模块

| 方法               | 说明                                                |
| ---------------- | ------------------------------------------------- |
| `harness.list`   | 列出已配置的 agent adapter（如 claude-code、codex、pi）      |
| `harness.status` | 检查某个 adapter 当前是否可用（凭证/环境是否就绪）                    |
| `harness.login`  | 触发某个 harness agent 后端自己的登录流程（跟 §7 连接层鉴权是两回事，见 §8） |
|                  |                                                   |
|                  |                                                   |
|                  |                                                   |
|                  |                                                   |

### 4.2 session 模块（核心）

其中 `list`/`rename`/`archive`/`delete`/`getMessages` 是"冷"操作，读写的是每个 adapter 自己的历史存储（§5.1 `SessionRepository`）；`create`/`resume`/`prompt`/`interrupt`/`respondToAgentRequest`/`getStatus`/`getSnapshot`/`close` 是"热"操作，作用于一个活跃的会话运行时（§5.1 `HarnessAgentSession`）；`subscribe` 是另一类——不读写任何一个 adapter，只是建立/管理事件推送订阅，见 §4.3。冷操作由 §5.2 `HarnessAgentSessionService` 委托给对应 adapter 的 `SessionRepository`；热操作由 `HarnessAgentSessionService` 结合 §5.1 `HarnessAgentRegistry` 解析出具体 adapter 后执行。

| 方法                              | 说明                                                  |
| ------------------------------- | --------------------------------------------------- |
| `session.list`                  | 列出会话摘要（冷）                                           |
| `session.subscribe`             | 订阅事件推送；传 `sessionId` 就只订阅这一个会话，不传就是所有会话（见 §4.3）     |
| `session.create`                | 创建新会话（拉起 agent 进程，热）                                |
| `session.resume`                | 恢复一个已存在但未在跑的会话（热）                                   |
| `session.prompt`                | 发送用户消息（热）                                           |
| `session.interrupt`             | 中断当前 agent 执行（热）                                    |
| `session.respondToAgentRequest` | 批准/拒绝 agent 的请求（如工具调用审批，热）                          |
| `session.getStatus`             | 查询当前状态（热）                                           |
| `session.getMessages`           | 拉取消息历史（冷）                                           |
| `session.getSnapshot`           | 拉取完整快照（消息 + 状态 + 元数据，热）                             |
| `session.rename`                | 重命名（冷）                                              |
| `session.archive`               | 归档（冷）                                               |
| `session.delete`                | 删除（冷）                                               |
| `session.close`                 | 主动结束会话（热）                                           |

### 4.3 events 模块

`session.subscribe` 是一个返回 oRPC event iterator（async generator）的 procedure，不是普通请求/响应；客户端 `for await` 消费它，`sessionId` 相关的会话事件都从这里多路复用地推过来（`fs` 是只读模块，不产生变化事件；`pty` 输出流是否也复用这条通道还没设计，见 §8）。服务端侧这个 iterator 由 Effect `Stream` 产出、在 oRPC 边界转成 event iterator（也可用 oRPC 的 Publisher helper 做多订阅扇出，见 §8）。完整的订阅、心跳、背压丢帧恢复、断线重连时序见配套架构图（文档开头链接）里的 frame ②「events 订阅时序图」。

三条不做在文字里重复、直接看图的机制：`seq` 单调递增、`gap` 丢帧合并、断线重连和背压丢帧走同一套"整个重新拉快照"逻辑，不做续传。另外两条图上不方便体现的设计决策：

- 服务端允许多个 WS 连接同时接入（比如 CLI 和 Web UI 同时连着同一个 Server），所有连接共享同一份广播事件流，不按连接过滤，这跟 OpenCode 多 UI 场景一致。
- 同一个 session 被多个客户端同时发起热操作（比如两边都调 `prompt`）时，不额外设计"连接级别加锁"，完全交给 `SessionLifecycle` 的不变量兜底——具体失败形式属于错误契约，这里不展开（见 §8）。

> 参考实现：事件枢纽对应参考实现里的 `session-event-hub.ts`；`getSnapshot` 在参考实现里叫 `getSessionSnapshot`，我们这边简化了方法名。

### 4.4 fs 模块

| 方法 | 说明 |
|---|---|
| `fs.readFile` | 读文件内容 |
| `fs.tree` | 获取某个路径下的目录树（递归） |
| `fs.grep` | 按内容搜索文件（类似 grep/ripgrep，按 pattern 找匹配的文件+行，具体参数见 §8） |
| `fs.search` | 按文件名/路径搜索（不看内容，具体参数见 §8） |

只读——不提供写文件/建目录/删除/复制这类写操作，也不提供 `watch`（没有写操作就没有本地变化需要监听，见 §8 若后续要加写能力需要重新评估）。

### 4.5 git 模块

只读——全部靠 shell 出去跑 `git` 命令，不做写操作（要不要加见 §8 待办）。方法命名尽量对齐 git CLI 子命令本身（`status`、`branch`……），不额外发明概念；方法列表先简化到最小集，其余（`isGitRepo`/`currentBranch`/`isGitWorktree`/`getContributors`/`getCommitStats`/`getActivityData`/`getRecentActivity`/`getConfig`/`getProjectGitInfo` 等）先不设计，见 §8。

| 方法 | 说明 |
|---|---|
| `git.status` | 工作区状态（对齐 `git status`：当前分支、暂存/未暂存/未跟踪文件等） |
| `git.branch` | 列出分支（对齐 `git branch`）；查默认分支就传个参数，不单独开方法 |

### 4.6 project 模块

| 方法 | 说明 |
|---|---|
| `project.list` | 项目列表 |
| `project.create` | 新建/按路径去重复用已有项目 |
| `project.remove` | 删除项目 |

会话是否归档是 `session` 模块自己的概念（`session.archive` + `session.list` 返回的摘要里带 `archived` 字段），不需要在 `project` 模块另开一个按项目分组的批量查询接口；"置顶会话""折叠的分组"是纯客户端本地展示状态，不属于 harness agent runtime 的领域模型，这套 runtime 不管。

### 4.7 skill 模块

每个 harness agent 后端都有自己的一套 skills 实现（装什么、怎么装、怎么启动都是后端自己的事），这里先只列出模块和方法名，具体机制不细化（见 §8 待办）。

| 方法                     | 说明                             |
| ---------------------- | ------------------------------ |
| `skill.list`           | 列出某个 harness agent 已安装的 skills |
| `skill.install`        | 给某个 harness agent 安装一个 skill   |
| `skill.enable/disable` | 启动/激活某个 skill                  |

### 4.8 provider 模块

`provider` 模块管的是 provider/凭证配置——支持内置 provider（预置好协议/endpoint，用户只需要填凭证）和用户自己配置的自定义 provider（任意 baseURL、任意 OpenAI-compatible 协议端点等），这属于"模型配置"；跟"模型市场"（可发现/浏览的第三方 provider 目录）是两回事，后者本设计不做（见 §1）。一个会话具体用哪个 model 由 adapter 自己决定，不在这层 runtime 的 `session.create` 里选（见 §8）。

| 方法                    | 说明                                                                   |
| --------------------- | -------------------------------------------------------------------- |
| `provider.list`       | 列出已配置的 provider（内置 + 自定义），可选按某个 `harnessAgentId` 过滤出协议兼容的            |
| `provider.listModels` | 列出某个/所有 provider 下的模型                                                |
| `provider.configure`  | 新增/更新一个 provider（含凭证）；已知的内置 id 只能覆盖凭证和启用状态，未知 id 就是一个全新的自定义 provider |

### 4.9 pty 模块

管理伪终端（pseudo-terminal）会话，给客户端一个能跑交互式命令行的通道；跟 `fs`/`git` 一样是纯环境能力，不按 `harnessAgentId` 分。这里先只列出方法名占位，具体机制不细化（见 §8 待办）。

| 方法 | 说明 |
|---|---|
| `pty.list` | 列出当前活跃的 pty 会话 |
| `pty.create` | 创建一个新的 pty 会话（拉起一个 shell 进程） |
| `pty.get` | 查询某个 pty 会话的当前状态 |
| `pty.update` | 更新一个 pty 会话（具体覆盖 resize、写入输入等哪些操作还没设计，见 §8） |
| `pty.delete` | 关闭并释放一个 pty 会话 |

### 4.10 mcp 模块

跟 `skill`（§4.7）是同一个模式——管理和开启分两步，不是像 `provider` 那样在 `session.create` 时当运行时参数动态传进去。`mcp.server.create`/`list` 只是在我们自己的 `McpRepository`（§5.1）里登记/查询配置；`enable` 才会把这份配置翻译成对应 harness agent 后端原生的 mcp 配置格式，写进它自己的配置文件（比如 claude-code 的 `.mcp.json`、codex 的 `config.toml`）——写完就结束了，不需要运行时再传一次；那个 harness agent 后端下次启动进程时自己读取这个文件，跟 `session` 模块完全没有交互。跟 skill 的共享目录 + 软链接（§5.3）比，机制不同（mcp server 是连接参数不是文件内容，没法软链接），但"管理与分发解耦、目标端自己读取"这个思路是一样的。

| 方法 | 说明 |
|---|---|
| `mcp.server.create` | 新增一个 MCP server 配置（stdio：command/args/env；或 remote：url，含凭证），只是登记，不会立刻对任何 harness agent 生效 |
| `mcp.server.list` | 列出已配置的 MCP server |
| `mcp.server.enable/disable` | 把某个 MCP server 配置写进/移出指定 harness agent 自己的原生配置文件 |

方法列表先简化到最小集，`mcp.server.update`/`mcp.server.remove`/列出某个 server 暴露的工具（类似 `provider.listModels`）这些先不设计；stdio 和 remote 两种配置形态怎么用一个 schema 统一表达、`enable` 具体怎么落到每个后端的原生格式，都还没设计，见 §8。

## 5. Services 抽象（服务端内部）

服务端全部用 Effect v4 写，对外经 oRPC v2 的 router 暴露：每个模块方法是一个 oRPC procedure，用官方 `@orpc/experimental-effect` 集成写成 `.effect(function* ({ input, context }) { … })`——procedure 里只做输入校验（可用 Effect Schema）和编排，`yield*` 对应的 Effect service 方法拿结果、把领域错误映射成 oRPC `ORPCError`，业务逻辑全部在 service 里。下面按角色列出每个抽象/service 和它们的依赖关系，不逐个方法展开。

命名约定（Effect v4）：凡是会被其他 service 按类型依赖注入的协作对象（下表里带 `IXxx` 接口的那批——各 Service、Registry、EventBus、三个 Repository、两个 Manager），都做成一个 Effect service——用一个 `Context` Tag 标识（Tag 的 Shape 就是原来的 `IXxx` 接口，方法返回 `Effect<A, E, R>` 而不是 `Promise`），再配一个 `Layer` 负责构造（命名 `XxxLayer`，对应下表"实现类"列）；消费方在 Effect 里 `yield*` 这个 Tag 拿到实例，依赖关系体现在 Layer 的 `RIn` 上，测试时换个 Layer 就能 mock。按 id 动态选择的多实现对象（`IHarnessAgentAdapter` / `IHarnessAgentSession`，以及每个后端各自的 `ISessionRepository` / `ISkillRepository` / `IMcpConfigWriter`）保持为普通接口（Shape），由对应 adapter 生产、由 Registry 持有，不各自做成 Tag/Layer；纯数据形状（DTO）、以及只有一份实现的 per-session 内部件（比如 `SessionLifecycle`）也是普通类型，下表里用"—"标出。类型化错误统一用 `Data.TaggedError` 定义（错误契约见 §8）。

### 5.1 核心类型与接口

| 接口 | 实现类 | 角色 |
|---|---|---|
| — | `HarnessAgentId` | `'claude-code' \| 'codex'`，统一标识 agent 后端；纯数据形状，不需要接口 |
| `IHarnessAgentAdapter` | `ClaudeCodeAdapter`、`CodexAdapter` | 每个后端各自实现的统一驱动接口：可用性检查、（可选）登录、创建/恢复/关闭活跃会话、持有一份 `ISessionRepository`、一份 `ISkillRepository`、一份 `IMcpConfigWriter` |
| `IHarnessAgentRegistry` | `HarnessAgentRegistry` | 持有构造时传入的 `IHarnessAgentAdapter` 数组，提供 `list()`/`get(id)`/`status()`；不再有 `dispose()`——常驻子进程（如 `CodexAdapter` 的 app-server）的释放由 `HarnessAgentRegistryLayer` 的 `Layer.scoped` finalizer 负责（见 §6）。是 `harness` 模块的实现，本身不做业务编排，其余 service 依赖它做 adapter 查询——没有归进 §5.2，因为除了持有构造时传入的数组之外没有别的依赖，更接近一个类型/容器而不是编排型 service |
| `IHarnessAgentSession` | `ClaudeCodeSession`、`CodexSession` | 一个活跃会话的运行时接口（`prompt`/`interrupt`/`close`/`getStatus`/`getSnapshot`/`respondToAgentRequest`），内部持有一个 `SessionLifecycle` |
| `IHarnessAgentSessionManager` | `HarnessAgentSessionManager` | 持有 `sessionId → IHarnessAgentSession` 的内存索引，提供 `register`/`get`/`remove`；纯内存态、不持久化（见 §5.3），进程重启后这份索引直接清空，客户端需要重新调 `session.resume` 才能拿回活跃实例。和 `HarnessAgentRegistry` 一样只是持有集合、没有业务编排，归进 §5.1 而不是 §5.2；管的是"活跃会话实例"，跟 `HarnessAgentRegistry` 管"HarnessAgent 后端本身的可用性/状态"是两个维度，别搞混 |
| `ISessionRepository` | 各后端各自实现（未单独命名） | 每个后端自己历史会话的冷存储接口（`list`/`rename`/`delete`/`archive`/`getMessages`），对应 `session` 模块里"冷"的那部分方法；实际存储由 harness agent 后端自己管，我们的 runtime 不设计它的格式，见 §5.3 |
| — | `SessionLifecycle` | 每个活跃会话一个实例，保证"一个 turn 有始有终、一个 `agent_request` 恰好被处理一次、结束后不再发事件"这几条不变量；只有一份共用实现、不跨后端多态，不需要接口 |
| `ISkillRepository` | 各后端各自实现（未单独命名） | 每个后端自己的 skills 安装/启动/列举实现，对应 `skill` 模块；实际内容统一装在 `~/.agents/skills/<name>/` 下，每个后端通过软链接接入自己期望的目录，见 §5.3；安装来源、和 session 的关系还没设计（见 §8） |
| `IMcpConfigWriter` | 各后端各自实现（未单独命名） | 每个后端自己把 `ResolvedMcpServerConfig` 翻译成原生格式、写进自己配置文件的实现（`enable`/`disable`），对应 `mcp` 模块；跟 `ISessionRepository`/`ISkillRepository` 一样是"每个后端自己懂自己的格式"，`McpService` 不关心具体怎么写，只负责编排，见 §5.3 |
| `IProjectRepository` | `ProjectRepository` | `$VIBEST_HOME/storage/projects.json` 的读写接口（原子写，见 §5.3），只做数据存取，不做业务规则 |
| `IProviderRepository` | `ProviderRepository` | `$VIBEST_HOME/config.json` 里 `provider` 字段的读写接口（原子写，见 §5.3），只做数据存取，不做业务规则 |
| `IMcpRepository` | `McpRepository` | `$VIBEST_HOME/config.json` 里 `mcp` 字段的读写接口（原子写，见 §5.3），只做数据存取，不做业务规则 |
| — | `ResolvedMcpServerConfig` | 解析后的 MCP server 连接参数（stdio：command/args/env；或 remote：url + 凭证），`enable` 时由 `McpService` 产出，用来生成写进目标 harness agent 原生配置文件的具体内容；纯数据形状，不需要接口 |
| `IPtyManager` | `PtyManager` | 持有 `ptyId → 具体 pty 进程句柄` 的内存索引，提供 `register`/`get`/`remove`；纯内存态、不持久化（见 §5.3）；跟 `HarnessAgentSessionManager` 同一个模式 |

工具审批（`respondToAgentRequest`）走的是"session 收到原生请求 → 存一个待处理的 resolver、经 `SessionLifecycle.emit` 推事件通知客户端 → 客户端响应时找到 resolver、翻译回原生协议、触发它、标记为已解决"这条路径；`SessionLifecycle` 负责在会话结束/崩溃时把没处理完的请求兜底标记掉，避免永远挂起。

### 5.2 Services 与依赖关系

| 接口 | 实现类 | 职责 | 依赖 |
|---|---|---|---|
| `IHarnessAgentSkillService`   | `HarnessAgentSkillService`   | skills 安装/启动/列举（细节未设计），`skill` 模块的实现                                                                                 | `IHarnessAgentRegistry`（§5.1）                                                |
| `IHarnessAgentSessionService` | `HarnessAgentSessionService` | 统一对外服务（`create`/`list`/`resume`/`prompt`/...），`session` 模块核心实现；会话生命周期编排逻辑在这，活跃实例的存取委托给 `IHarnessAgentSessionManager` | `IHarnessAgentRegistry`（§5.1）、`IHarnessAgentSessionManager`（§5.1）、`IEventBus` |
| `IModelProviderService`       | `ModelProviderService`       | provider 配置的增删改查、凭证管理、列出 provider 下的模型，`provider` 模块的实现                          | `IProviderRepository`（§5.1）                                                  |
| `IMcpService`                 | `McpService`                 | `mcp` 模块的实现（细节未设计，见 §8）；`enable`/`disable` 时用 `IHarnessAgentRegistry` 查到目标 adapter，调它的 `IMcpConfigWriter.enable/disable`——具体怎么翻译成原生格式、写到哪个文件，是每个 adapter 自己的事，`McpService` 只做编排，跟 `session` 生命周期没有交互 | `IMcpRepository`（§5.1）、`IHarnessAgentRegistry`（§5.1）                        |
| `IEventBus`                   | `EventBus`                   | 事件枢纽：会话事件统一从这里推送，含背压丢帧提示（`gap`）、心跳（`ping`），支持多个并发订阅连接（广播，不按连接过滤）                                                     | 无（共享单例）                                                                     |
| `IFSService`                  | `FSService`                  | `fs` 模块实现（只读：readFile/tree/grep/search）                                                                              | 无                                                                           |
| `IGitService`                 | `GitService`                 | `git` 模块实现；Service 层写操作方法齐全，只对外暴露只读子集（见 §8）                                                                          | 无（仅一个日志 sink）                                                               |
| `IProjectService`             | `ProjectService`             | `project` 模块实现，另有 `findById`/`update` 等内部方法未对外暴露；实际读写落地在 `IProjectRepository`（见 §5.3），自己只做路径去重这类业务规则 | `IProjectRepository`（§5.1）                                                   |
| `IPtyService`                 | `PtyService`                 | `pty` 模块的实现（细节未设计）；活跃 pty 实例的存取委托给 `IPtyManager`                                                                        | `IPtyManager`（§5.1）、`IEventBus`                                                    |

`HarnessAgentSessionService` 不依赖 `ProjectService`——`workspacePath` 由 WS 路由 handler 用 `ProjectService.findById` 解析好之后再传进来。活跃会话的 `sessionId → HarnessAgentSession` 索引由 `HarnessAgentSessionManager`（§5.1）维护，调用方一个 `sessionId` 就能定位会话，不用额外带上 `harnessAgentId`。`create` 时 `HarnessAgentSessionService` 把 `workspacePath` 交给 `HarnessAgentRegistry` 查到的 adapter 的 `createSession`，拿到返回的 `HarnessAgentSession` 实例后调用 `HarnessAgentSessionManager.register()` 存进索引；`close` 时则是先按 `sessionId` 从 `HarnessAgentSessionManager.get()` 取出实例、调用它的 `close()`，再 `HarnessAgentSessionManager.remove()` 把索引里的条目摘掉。

### 5.3 数据存储

存储格式和文件读写只属于 `ProjectRepository`/`ProviderRepository`/`McpRepository`（§5.1）——`ProjectService`/`ModelProviderService`/`McpService` 不直接碰文件，只调用各自 Repository 的存取方法，业务规则（路径去重、凭证解析等）留在 Service 层。`$VIBEST_HOME` 未设置时默认 `~/.vibest`——默认目录名用 vibest 自己的，不复用参考实现的目录，避免两边同时装在一台机器上互相踩到对方的数据。

| 文件 | 归属 Repository | 格式 |
| --- | --- | --- |
| `$VIBEST_HOME/storage/projects.json` | `ProjectRepository` | 单文件 JSON，整体读写，只存 `Project[]`——不像参考实现那样把 `archivedSessions`/`pinnedSessions`/`closedProjectAccordions` 等也塞进同一个文件；这些字段要么已经挪到别处（`archived` 归 `session` 模块自己管，见 §4.6），要么本来就不该持久化（`pinned`/折叠分组是纯 UI 本地状态，见 §1） |
| `$VIBEST_HOME/config.json`（`provider` 字段） | `ProviderRepository` | provider 属于"配置"性质的数据，不单独开一个文件，跟参考实现一样放进一份整体配置文件里的 `provider` 字段——内置 provider 的覆盖项、自定义 provider、凭证（`apiKey` 等）都在这个字段里，不单独拆分（凭证同文件存放，见 §8 关于文件权限的待办） |
| `$VIBEST_HOME/config.json`（`mcp` 字段） | `McpRepository` | mcp server 配置，跟 `provider` 同理归进这份整体配置文件，不单开文件；remote 类型的凭证也同文件存放，见 §8 关于文件权限的待办 |

`projects.json` 在 `storage/` 子目录下，`config.json` 直接放在 `$VIBEST_HOME` 根下，不跟着进 `storage/`——两者语义不同：前者是一份数据集合，后者是单份整体配置，这也是参考实现里 `config.json` 本来的位置。两个文件都采用"写临时文件 + 原子 rename"的更新方式（参考实现同样如此），避免进程崩溃导致文件写到一半、内容损坏。`config.json` 目前只放 `provider`/`mcp` 这两个字段，没有引入其他通用应用配置（见 §1 的范围排除）。

会话历史不在这套约定里——`SessionRepository` 只是个接口，实际存储完全由每个 harness agent 后端自己管，我们的 runtime 不碰、也不设计它的格式。参考实现里 claude-code 是 `~/.claude/projects/<project>/<sessionId>.jsonl`（每个 session 一个文件，一行一条记录），codex 是 `~/.codex/sessions/` 下的 rollout jsonl + 一个 `codex.db` SQLite 索引，而且服务端从不直接读写这些文件，只通过 codex app-server 的 RPC（`thread/list`/`thread/read` 等）间接访问；两边都是各自 CLI 的黑盒。

`skill` 内容统一装在 `~/.agents/skills/<name>/` 下——不在 `$VIBEST_HOME` 下，因为这是 agent 生态共享的东西，不是这套 runtime 私有的数据。每个 harness agent 后端需要用到某个 skill 时，在自己期望的目录下建一个软链接指向它（比如 claude-code 的 `.claude/skills/<name>`、codex 的 `.codex/skills/<name>`），避免每个后端各自拷贝一份内容。`skill.install` 具体怎么把内容下载/复制进 `~/.agents/skills`、软链接是全局建一次还是每个 project 各建一份，这些还没设计（见 §8）。

`pty` 会话不持久化——纯内存状态，进程重启即丢失；参考实现里也没有 PTY 持久化，这符合"伪终端天然是易失的"这个直觉。

> 参考实现（下列均为参考实现中的路径）：`features/project/store.ts`（projects.json + 原子写）、`features/config/service.ts`（provider 配置 + 凭证同文件）、`features/agent/providers/{claude-code,codex}/*session-repository.ts`（会话历史委托给 adapter 原生存储）。

### 5.4 核心接口定义（session 相关）

§4.2 里每个 `session.*` 方法具体落在哪个类型上，把下面这几个核心接口的方法签名写清楚就不用再猜：

下面所有方法都返回 `Effect<A, E, R>` 而不是 `Promise`，`subscribe` 返回 `Stream`；错误类型用 `Data.TaggedError`（这里只示意，完整错误契约见 §8）。带 `IXxx` 接口的是 Effect service 的 Shape，配一个 `Context` Tag + `Layer`（示例见 `HarnessAgentSessionService`）；`IHarnessAgentAdapter` / `IHarnessAgentSession` / `ISessionRepository` 是按 id 动态选择的普通 Shape，不做成 Tag/Layer。

```typescript
import { Context, Effect, Stream, Data } from 'effect';

// 类型化错误统一用 Data.TaggedError（示意）
class SessionNotFound extends Data.TaggedError('SessionNotFound')<{ sessionId: string }> {}
class HarnessAgentUnavailable extends Data.TaggedError('HarnessAgentUnavailable')<{ id: HarnessAgentId; reason?: string }> {}

// ---- Registry：管 HarnessAgent 后端本身的可用性/状态，不碰会话（Effect service）----
interface HarnessAgentRegistryShape {
  readonly list: () => ReadonlyArray<IHarnessAgentAdapter>;
  readonly get: (id: HarnessAgentId) => IHarnessAgentAdapter | undefined; // 冷操作路由要用，见下面
  readonly status: (id: HarnessAgentId) => Effect.Effect<{ available: boolean; reason?: string }>;
  // 不再有 dispose：常驻子进程（如 CodexAdapter 的 app-server）的释放交给 Registry 的
  // Layer.scoped + Effect.acquireRelease 注册 finalizer，见 §6
}
class HarnessAgentRegistry extends Context.Tag('HarnessAgentRegistry')<
  HarnessAgentRegistry,
  HarnessAgentRegistryShape
>() {}

// ---- Adapter：按 id 动态选择的普通 Shape（不是 Tag/Layer），由具体 adapter 实现 ----
interface IHarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly sessionRepository: ISessionRepository;
  readonly skillRepository: ISkillRepository;
  readonly mcpConfigWriter: IMcpConfigWriter;

  readonly checkAvailability: () => Effect.Effect<{ available: boolean; reason?: string }>;
  readonly login?: () => Effect.Effect<unknown>; // 机制未定，见 §8
  readonly createSession: (config: { workspacePath: string }) => Effect.Effect<IHarnessAgentSession>;
  readonly resumeSession: (sessionId: string) => Effect.Effect<IHarnessAgentSession, SessionNotFound>;
}

// ---- McpConfigWriter：每个后端自己把配置翻译成原生格式、写进自己配置文件的实现 ----
interface IMcpConfigWriter {
  readonly enable: (server: ResolvedMcpServerConfig) => Effect.Effect<void>;
  readonly disable: (serverId: string) => Effect.Effect<void>;
}

// ---- Session：一个活跃会话的运行时 Shape（多实例，由 Registry/adapter 生产）----
interface IHarnessAgentSession {
  readonly id: string; // 格式 `${harnessAgentId}:${uuid}`，见下面路由说明
  readonly prompt: (input: { text: string }) => Effect.Effect<void>;
  readonly interrupt: () => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
  readonly getStatus: () => Effect.Effect<SessionStatus>;
  readonly getSnapshot: () => Effect.Effect<SessionSnapshot>; // 消息+状态+元数据，直接读内存，不查 ISessionRepository
  readonly respondToAgentRequest: (requestId: string, response: AgentRequestResponse) => Effect.Effect<void>;
}

// ---- SessionManager：管活跃实例的内存索引，不做业务编排（Effect service，内部用 Ref）----
interface HarnessAgentSessionManagerShape {
  readonly register: (session: IHarnessAgentSession) => Effect.Effect<void>;
  readonly get: (sessionId: string) => Effect.Effect<IHarnessAgentSession | undefined>;
  readonly remove: (sessionId: string) => Effect.Effect<void>;
}
class HarnessAgentSessionManager extends Context.Tag('HarnessAgentSessionManager')<
  HarnessAgentSessionManager,
  HarnessAgentSessionManagerShape
>() {}

// ---- SessionRepository：每个后端自己历史会话的冷存储 Shape（按 id 动态选择，不是 Tag/Layer）----
interface ISessionRepository {
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>>;
  readonly getMessages: (sessionId: string) => Effect.Effect<ReadonlyArray<Message>, SessionNotFound>;
  readonly rename: (sessionId: string, name: string) => Effect.Effect<void, SessionNotFound>;
  readonly archive: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  readonly delete: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
}

// ---- SessionService：对外统一门面，session 模块的实现（Effect service）----
interface HarnessAgentSessionServiceShape {
  readonly list: () => Effect.Effect<ReadonlyArray<SessionSummary>>;
  readonly subscribe: (sessionId?: string) => Stream.Stream<SessionEvent>;
  readonly create: (input: { projectId: string; harnessAgentId: HarnessAgentId }) => Effect.Effect<{ sessionId: string }, HarnessAgentUnavailable>;
  readonly resume: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  readonly prompt: (sessionId: string, input: { text: string }) => Effect.Effect<void, SessionNotFound>;
  readonly interrupt: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  readonly respondToAgentRequest: (sessionId: string, requestId: string, response: AgentRequestResponse) => Effect.Effect<void, SessionNotFound>;
  readonly getStatus: (sessionId: string) => Effect.Effect<SessionStatus, SessionNotFound>;
  readonly getMessages: (sessionId: string) => Effect.Effect<ReadonlyArray<Message>, SessionNotFound>;
  readonly getSnapshot: (sessionId: string) => Effect.Effect<SessionSnapshot, SessionNotFound>;
  readonly rename: (sessionId: string, name: string) => Effect.Effect<void, SessionNotFound>;
  readonly archive: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  readonly delete: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
  readonly close: (sessionId: string) => Effect.Effect<void, SessionNotFound>;
}
class HarnessAgentSessionService extends Context.Tag('HarnessAgentSessionService')<
  HarnessAgentSessionService,
  HarnessAgentSessionServiceShape
>() {}
```

> Effect v4 的 service 构造器在 beta 期间（`ServiceMap` ↔ `Context`）反复改过名，上面用 `Context.Tag` 的 class 写法只是示意——落地时以最终 release 的确切 API 为准（见 §8）。

§4 的每个 oRPC procedure 就是把这些 service 方法包一层。以 `session.create` 为例（`@orpc/experimental-effect` 的 `.effect` 写法）：

```typescript
import { Schema } from 'effect';

export const sessionRouter = {
  create: base
    .input(Schema.Struct({
      projectId: Schema.String,
      harnessAgentId: Schema.Literal('claude-code', 'codex'),
    }))
    .effect(function* ({ input }) {
      // Effect service 从 oRPC context（'effect/context'，见 §6）注入
      const sessions = yield* HarnessAgentSessionService;
      const projects = yield* ProjectService;
      const workspacePath = yield* projects.findById(input.projectId);
      return yield* sessions.create({ ...input, workspacePath });
      // service 里 Effect.fail 的领域错误（如 HarnessAgentUnavailable）由集成映射成 oRPC ORPCError
    }),
  // subscribe：.effect 里 return 一个 Effect Stream，oRPC 边界转成 event iterator（§4.3）
};
```

其余 `session.*`、`harness.*`、`fs.*` 等 procedure 都是这个模式：`yield*` 对应 §5.2 的 Effect service，冷操作路由（下面那段）也在 procedure/service 里做。

`SessionSummary`/`Message`/`SessionStatus`/`SessionSnapshot`/`SessionEvent`/`AgentRequestResponse` 只是占位类型名，具体字段没有展开设计（事件 payload 见 §8）。

上一轮追出来的"冷操作怎么路由到具体 adapter"的洞，这里给一个解法并落到接口里：`create`/`resume` 生成的 `sessionId` 格式定为 `${harnessAgentId}:${uuid}`（`IHarnessAgentSession.id` 那行的注释）；`IHarnessAgentSessionService` 的 `getMessages`/`rename`/`archive`/`delete` 这几个冷方法，拿到 `sessionId` 后先切出前缀部分的 `harnessAgentId`，用新加的 `IHarnessAgentRegistry.get(id)` 查到对应 adapter，再调 `adapter.sessionRepository.<method>(sessionId)`——不需要额外的路由表，也不用调用方多传一个 `harnessAgentId` 参数。这是本设计对上一轮那个洞给出的具体方案，如果不想用 ID 编码前缀这个办法，需要另外讨论。

mcp server 不在 `createSession` 的参数里——`enable` 时已经把配置写进了 harness agent 自己的原生配置文件，adapter 拉起进程时会自己读到，`session` 这条链路不用管（见 §4.10）。

## 6. 装配根与依赖图

服务端不再有手写的装配根 `class`——每个 service 一个 `Layer`，启动时把它们 `Layer.mergeAll` 成一个根 Layer、按依赖 `Layer.provide` 连起来，在一个 `Scope` 里运行；`Scope` 关闭时 finalizer 自动逆序跑，不用手写 `dispose()`。下面 `Layer` 的命名对应 §5.1/§5.2 表里的"实现类"列：

```typescript
import { Effect, Layer } from 'effect';

// 无外部资源的 service：Layer.effect / Layer.sync 直接构造
const RepositoriesLayer = Layer.mergeAll(
  ProjectRepositoryLayer,
  ProviderRepositoryLayer,
  McpRepositoryLayer,
);

// 持有子进程/定时器的 service：Layer.scoped + Effect.acquireRelease 注册 finalizer
const HarnessAgentRegistryLayer = Layer.scoped(
  HarnessAgentRegistry,
  Effect.gen(function* () {
    const claude = yield* makeClaudeCodeAdapter;
    const codex = yield* makeCodexAdapter; // 常驻 app-server：acquire 拉起、finalizer 里 kill
    return makeRegistry([claude, codex]);
  }),
);
const EventBusLayer = Layer.scoped(EventBus, makeEventBus);                          // finalizer 停 ping、清订阅队列
const HarnessAgentSessionManagerLayer = Layer.sync(HarnessAgentSessionManager, makeSessionManager); // 纯内存 Ref
const PtyManagerLayer = Layer.scoped(PtyManager, makePtyManager);                    // finalizer 里 kill 所有存活 shell

// 根 Layer：合并所有对外 service，再把它们依赖的基础 service provide 进去
export const HarnessAgentServerLayer = Layer.mergeAll(
  ProjectServiceLayer,
  GitServiceLayer,
  FSServiceLayer,
  ModelProviderServiceLayer,
  McpServiceLayer,
  HarnessAgentSkillServiceLayer,
  HarnessAgentSessionServiceLayer,
  PtyServiceLayer,
).pipe(
  Layer.provide(HarnessAgentRegistryLayer),
  Layer.provide(HarnessAgentSessionManagerLayer),
  Layer.provide(PtyManagerLayer),
  Layer.provide(EventBusLayer),
  Layer.provide(RepositoriesLayer),
);
```

跑起来就是用这个根 Layer 建一个 `ManagedRuntime`（或直接 `Layer.launch` 进一个常驻 `Scope`），把它接到 oRPC 的 WS `RPCHandler` 上——`@orpc/experimental-effect` 通过 oRPC context（`'effect/context'` / `'effect/wrap'`）把 runtime 提供给每个 `.effect` procedure，于是 procedure 里 `yield*` 的 §5 service 都来自这个根 Layer；进程收到停止信号时关闭根 `Scope`，finalizer 逆序执行（先 kill pty shell、再 kill codex app-server、再停 EventBus ping）。

依赖关系见 §5.2；这里补一点 §5.2 没提到的：`EventBus` 靠 `Layer` 的 memoization 成为整个根 Layer 里的共享单例（同一个 `EventBusLayer` 被多个 service provide 也只构造一次），注入给 `HarnessAgentSessionService`，`PtyService` 也依赖它来推送终端输出，但具体怎么复用还没设计（见 §8）。

资源清理全部交给 `Scope`/finalizer，不再有手写的 `dispose()`：`HarnessAgentRegistryLayer` 用 `Layer.scoped` 构造，`CodexAdapter` 的常驻 `codex app-server` 子进程在 `Effect.acquireRelease` 的 acquire 里拉起、release 里 kill；`EventBusLayer` 的 finalizer 停掉 ping 定时器、清空订阅队列；`PtyManagerLayer` 的 finalizer 挨个 kill 存活的 shell 子进程。`HarnessAgentSessionService` 和 `HarnessAgentSessionManager` 自己不持有需要释放的资源——`HarnessAgentSessionManager` 里存的 `HarnessAgentSession` 实例背后即使包着子进程句柄，释放也是靠 `HarnessAgentSessionService.close()` 先调实例的 `close()`，`remove()` 只是摘除内存索引引用；`ProjectService`/`GitService`/`ModelProviderService`/`FSService`（以及三个 Repository）都是无状态的按次文件/进程 I/O，用 `Layer.effect`/`Layer.sync` 构造即可，不注册 finalizer。根 `Scope` 关闭时这些 finalizer 逆序执行，顺序和资源依赖相反，避免先关了别人还依赖的东西。

## 7. 鉴权

未配置密码环境变量时不做任何校验；配置了密码后，在 WS 握手阶段校验 `Authorization: Basic` header（或 query token），校验失败拒绝升级连接。

## 8. 待办事项

- `sessionId` 用 `${harnessAgentId}:${uuid}` 前缀编码来解决冷操作路由（见 §5.4）——这是目前给出的具体方案，还没有验证这个格式会不会跟某个后端自己的原生会话 ID 格式冲突，也没考虑要不要对客户端暴露这个内部编码细节（比如要不要在协议层面当它是不透明字符串处理）。
- `$VIBEST_HOME/config.json` 里的凭证（`provider`/`mcp` 两个字段都可能有）目前跟其余配置存在同一个文件、没有做文件权限收紧（比如 `chmod 600`）——参考实现里同样没做，但这套 runtime 要不要主动补上这个小的安全加固，还没决定。
- `EventBus` 的背压阈值（相当于"缓冲队列上限"）、ping 间隔、gap 之后客户端具体怎么补状态，这几个数值/流程还没敲定，需要确认。
- Effect v4 的 service 构造器 API 在 beta 期间（`ServiceMap` ↔ `Context`）反复改过名，本文档 §5.4/§6 用 `Context.Tag` + `Layer` 只是示意——`@vibest/server` 落地时以最终 release 的确切 service/Layer 构造器为准，需要确认。
- 传输层用 oRPC v2 的 WS `RPCHandler`（`@orpc/server/websocket`）+ `@orpc/client` 的 WS link；官方 Effect 集成 `@orpc/experimental-effect` 目前是 experimental/beta（要配 `effect@beta`），API 可能变、还得跟 §5.4/§6 用的 Effect v4 版本对齐，落地时需要 pin 版本并验证。
- §4.3 的 `seq`/`gap`/断线重连补快照是我们自己在 event iterator 之上叠的一层语义——需要确认它跟 oRPC event iterator 自带的生命周期（`.return`/signal 取消、重连）怎么配合，以及事件扇出（多订阅广播）要不要直接用 oRPC 的 Publisher helper 而不是自己写 `EventBus`。
- 类型定义手动同步的维护成本——后续要不要收敛成一个共享的轻量 types 包，现在先不做。
- `git` 模块的写操作（`checkout`/`createBranch`/`switchBranch` 等）Service 层已经实现，但故意没有注册成 API——需要确认是否真的不需要对外开放。
- `git` 模块目前只保留 `status`/`branch` 两个方法，是临时简化——`isGitRepo`/`currentBranch`/`isGitWorktree`/`getContributors`/`getCommitStats`/`getActivityData`/`getRecentActivity`/`getConfig`/`getProjectGitInfo` 这些先不设计，要不要加回来、加哪些，还没决定；`git.branch` 里"查默认分支"具体传什么参数也还没定。
- `fs` 模块没有路径越界保护，是否要限制在某个 `project.path` 白名单内、防止越权访问宿主机任意路径，需要确认。
- `fs.grep`/`fs.search` 的具体参数（大小写/正则开关、结果数量上限与分页、是否遵守 `.gitignore`、`fs.tree` 的递归深度限制）还没设计。
- `HarnessAgentSession` 目前只定义了 v1 必须的方法（prompt/interrupt/close/getStatus/getSnapshot/respondToAgentRequest）；像"回退到某条历史消息重新生成"、"从某条消息分叉出一个新会话"这类进阶能力，哪些 adapter 支持、要不要在 v1 就设计成可选方法，还没决定。
- `skill` 模块目前只有方法名占位（`list`/`install`/`enable/disable`）——`skill.install` 具体从哪下载/复制内容（本地目录、远程 registry、还是别的）、软链接是全局建一次还是每个 project 各建一份、和 session 是什么关系（会话级还是全局级生效）、每个后端（claude-code/codex）的 skill 格式是否统一，这些都还没设计；存储位置本身已经定了（`~/.agents/skills/<name>` + 软链接进各后端目录，见 §5.3）。
- `harness.login` 目前也只是占位——各 harness agent 后端登录方式差异很大（OAuth 网页授权、CLI 粘贴 API key、已经有 env var 直接免登录等）；尤其 OAuth 这类需要打开浏览器的流程，在服务端是远程运行的场景下要怎么处理（返回一个 URL/code 让客户端在用户本机打开？）还没设计。
- 事件信封（envelope）没有给出具体字段结构的示例——§4.3 只定义了 `kind` 的取值，一条 `turn_started` 之类的事件实际长什么样，需要补一个典型 payload 示例。
- RPC 方法调用本身要不要超时/取消语义，还没设计——注意这跟 `interrupt`（取消的是 agent turn）是两回事。
- §7 鉴权目前只覆盖连接层（Basic Auth），但 `fs`/`git` 能读取宿主机文件系统，信任边界比"连上了就行"更大；这条要跟"fs 没有路径越界保护"那条待办一起考虑，鉴权章节需要明确写清楚这是两层不同的东西。
- §3 提到"同一个 session 被多个客户端同时发起热操作时，交给 `SessionLifecycle` 的不变量兜底，具体失败形式属于错误契约"——这个错误契约本身还没设计（后到的调用是直接报错、排队等待、还是覆盖前一个），`IHarnessAgentSession` 各方法要不要抛出特定错误类型也取决于这条，目前还是空的。错误统一走 Effect 的类型化错误（`Data.TaggedError`），但具体有哪些 tagged error、各方法 `Effect<A, E, R>` 的 `E` 通道到底列哪些，等这条契约定了再补（§5.4 里的 `SessionNotFound`/`HarnessAgentUnavailable` 只是示意）。
- `provider.configure` 目前没有凭证校验（比如新配的自定义 provider 到底能不能连通）——参考实现里这块也没做真正的网络探测，只是"填了 apiKey 就认为 ready"，要不要在这套 runtime 里加一个真正探测的 `testCredential` 方法，还没决定。
- `session.create` 不再选 model——一个会话用哪个 model 完全由 adapter 自己的默认值决定；每个 adapter（claude-code/codex）零配置状态下到底用哪个 model、要不要暴露一个改默认 model 的途径，还没设计。
- `provider.list` 里"按 `harnessAgentId` 过滤协议兼容的 provider"具体怎么判断兼容（比如某个 adapter 只支持特定协议家族）——`HarnessAgentAdapter` 目前没有声明自己支持哪些协议，这条过滤逻辑要不要做、怎么做还没设计。
- `pty` 模块目前只有方法名占位——`pty.update` 具体覆盖哪些操作（resize、写输入、还是别的）没有设计；pty 的输出流怎么推送给客户端（复用 §4.3 events 通道还是别的机制）没有设计（`PtyManager` 已经确定持有真实的子进程句柄而不是纯索引引用，`IPtyService` 依赖 `IEventBus` 也已经在 §6 装配根里定下来了，这两点不再是待定项，只是具体的推送机制还没设计）；`PtyManager` 持有的 shell 子进程由 `PtyManagerLayer` 的 `Layer.scoped` finalizer 在根 `Scope` 关闭时统一 kill（见 §6），但客户端断线后的按需清理、超时策略这类 pty 进程生命周期管理还没设计。
- `mcp` 模块目前只有方法名占位（`mcp.server.create`/`list`/`enable/disable`）——stdio（command/args/env）和 remote（url + 凭证）两种 MCP server 配置形态怎么用一个 schema 统一表达没有设计；`mcp.server.update`/`mcp.server.remove`/列出某个 server 暴露的工具（类似 `provider.listModels`）先不设计。`enable` 把 `ResolvedMcpServerConfig` 翻译成每个后端原生格式（claude-code 的 `.mcp.json`、codex 的 `config.toml`）这份能力已经定为每个 adapter 自己实现（`IMcpConfigWriter`，见 §5.1/§5.4），但每个后端具体怎么翻译还没设计；配置文件是项目级（比如 claude-code 的 `.mcp.json` 通常放在项目根目录）还是用户级，`enable` 要不要传 `workspacePath`，这条待办跟 `skill` 那条"软链接全局建一次还是每个 project 各建一份"是同一类问题，没有一起解决；`enable` 要不要实际连接做健康检查/超时处理也没考虑。

## 9. React 状态管理层（vibest 内部模块）

vibest 前端消费这套运行时的 React 状态层——依赖 §3 的 `@vibest/client`（oRPC 客户端的薄封装），不直接碰 WS/oRPC，先作为 vibest 内部模块存在（具体落在哪个前端包待定），不单独发布成 SDK。目的：把"建连、订阅事件、断线重连补快照"这套 §3 里手写的样板逻辑封装掉，业务代码只用 hook 读状态、调用几个 action，不用自己维护订阅循环和 reducer——即"根据状态渲染 UI"。

内部用 [zustand](https://github.com/pmndrs/zustand) 维护一份全局 store（一个 React 应用一份，不是每个组件一份），大致结构：

```typescript
interface HarnessAgentStore {
  harnessAgents: HarnessAgentInfo[]; // client.harness.list() 缓存
  sessions: Record<string, SessionState>; // sessionId -> 单个会话的状态
  connectionStatus: 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
}

interface SessionState {
  status: SessionStatus; // 同 §5.4 IHarnessAgentSession.getStatus()
  messages: Message[];
  pendingAgentRequests: AgentRequest[]; // 等待 respondToAgentRequest 的请求
}
```

有一个内部的"驱动器"（暂定名 `HarnessAgentStoreDriver`），持有一份 client 实例，订阅 `client.session.subscribe()`，把收到的每个事件 reduce 进 store；`client.on('reconnected')` 时自动对 store 里已 track 的 sessionId 挨个调 `getSnapshot` 补状态——这段逻辑原本要业务代码自己写（见 §3 的示例），挪进这一层之后业务代码不用管。

对外只暴露 hook，不暴露 store 本身：

| Hook/方法 | 说明 |
|---|---|
| `useHarnessAgents()` | 读 `harnessAgents` 列表，首次调用自动触发 `harness.list()` |
| `useSession(sessionId)` | 读某个会话的 `SessionState`；组件订阅了这个 hook 会随 store 更新自动重渲染 |
| `useSessionList(projectId?)` | 读会话摘要列表 |
| `useCreateSession()` | 返回一个 `create` 方法，内部调 `client.session.create` 并把新会话状态塞进 store |
| `usePrompt(sessionId)` | 返回一个 `prompt` 方法，包一层 `client.session.prompt` |

这一层不重新设计 §4 的方法/协议，纯粹是"客户端访问 → 好用的 React hook"的薄封装。具体 reducer 细节（比如收到 `gap` 事件要不要先清空消息缓存再重新拉快照、`pendingAgentRequests` 怎么在 UI 层触发审批弹窗、`useSessionList` 的 `projectId` 过滤要不要等 §8 里 `ISessionRepository` 的项目维度设计定了再做）都还没细化，算是这个包自己的待办，不并入 §8。
