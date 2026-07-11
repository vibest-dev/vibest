# Neo HarnessAgent SDK 设计文档

> 配套架构图：[2026-07-09-neo-harness-agent-sdk-overview.excalidraw](2026-07-09-neo-harness-agent-sdk-overview.excalidraw)，用 excalidraw 打开后按 frame 分两块看——① 模块架构图（模块划分 + WS Server 结构）、② events 订阅时序图（§4.3 订阅/心跳/丢帧恢复/断线重连时序）

> 范围：覆盖 harness agent 运行时的核心能力域——`session`（会话生命周期与交互，核心模块）、`harness`（可用 agent adapter 信息）、`skill`（skills 安装与管理，暂不细化）、`provider`（模型/provider 配置，含自定义 provider）、`mcp`（MCP server 配置，暂不细化）、`fs`（文件读取/检索，只读）、`git`（只读 git 信息）、`project`（项目管理）、`pty`（伪终端会话管理，暂不细化）；不含任务看板、agent 执行器注册表、模型市场（可发现/浏览的第三方 provider 目录，跟"配置已有 provider"是两回事，见 §4.8）、通用应用配置等其他领域——"置顶会话""折叠分组""主题色"这类是纯 UI 本地状态，都不属于这套 headless runtime 该管的范围。
>
> 定位：一套独立的 Harness Agent Client-Server 实现——服务端用开源 Egg.js 手写（不使用 TEGG 装饰器/DI），客户端和服务端之间只有一条 WS 连接，用方法调用 + 事件推送的方式通信，不是 REST；鉴权对齐 OpenCode 的模式——默认不鉴权，可选 `Authorization: Basic`。

## 1. 目标与范围

目标是设计一套通用的 Harness Agent Client-Server 架构：服务端托管 agent harness 的运行时（session 生命周期 + fs/git/project 能力），客户端通过一条 WS 连接远程驱动它。三个 NPM 包只是这套架构最终交付的产物。

- 鉴权默认关闭；设置密码环境变量后要求 `Authorization: Basic <base64(user:pass)>`（在 WS 握手阶段校验）。

## 2. 包结构

- `packages/neo-harness-agent-server`（`@alipay/neo-harness-agent-server`）——服务端。
- `packages/neo-harness-agent-client`（`@alipay/neo-harness-agent-client`）——客户端 SDK。
- `packages/neo-harness-agent-react`（`@alipay/neo-harness-agent-react`）——React 状态管理层，依赖客户端 SDK，见 §9。

## 3. 使用方式

核心用法——建连、挑一个可用的 harness agent、创建会话、发消息、订阅事件；完整方法列表见 §4。

```typescript
import { createNeoHarnessClient } from '@alipay/neo-harness-client';

const client = createNeoHarnessClient({
  url: 'ws://127.0.0.1:7001',
  // 可选：只有服务端设置了密码才需要传
  headers: { Authorization: `Basic ${Buffer.from('opencode:xxx').toString('base64')}` },
});

// 断线重连后没有历史事件回放，SDK 只负责告诉你"该去补快照了"
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

// 订阅事件（异步迭代器；不传 sessionId 订阅所有会话）
for await (const event of client.session.subscribe()) {
  console.log(event.harnessAgentId, event.sessionId, event.type, event.payload);
}
```

## 4. API 模块

服务端只提供一条 WS 连接；建连后客户端用 JSON-RPC 风格的消息（`{ id, method, params }` → `{ id, result }` / `{ id, error }`）调用下面各模块的方法，服务端也在同一条连接上主动推送事件（§4.3）。共十个模块，按 §4.1–4.10 展开；其中 `harness`/`skill`/`session` 背后分别对应服务端内部的 `HarnessAgentRegistry`（§5.1）、`HarnessAgentSkillService`、`HarnessAgentSessionService`（§5.2）——外部方法命名空间去掉了 `HarnessAgent` 前缀，内部实现类名不跟着改。

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

其中 `list`/`rename`/`archive`/`delete`/`getMessages` 是"冷"操作，读写的是每个 adapter 自己的历史存储（§5.1 `SessionRepository`）；`create`/`resume`/`prompt`/`interrupt`/`respondToAgentRequest`/`getStatus`/`getSnapshot`/`configure`/`close` 是"热"操作，作用于一个活跃的会话运行时（§5.1 `HarnessAgentSession`）；`subscribe` 是另一类——不读写任何一个 adapter，只是建立/管理事件推送订阅，见 §4.3。冷操作由 §5.2 `HarnessAgentSessionService` 委托给对应 adapter 的 `SessionRepository`；热操作由 `HarnessAgentSessionService` 结合 §5.1 `HarnessAgentRegistry` 解析出具体 adapter 后执行。

| 方法                              | 说明                                                  |
| ------------------------------- | --------------------------------------------------- |
| `session.list`                  | 列出会话摘要（冷）                                           |
| `session.subscribe`             | 订阅事件推送；传 `sessionId` 就只订阅这一个会话，不传就是所有会话（见 §4.3）     |
| `session.create`                | 创建新会话（拉起 agent 进程，热；可选带 `selection` 指定用哪个模型，见 §4.8） |
| `session.resume`                | 恢复一个已存在但未在跑的会话（热）                                   |
| `session.configure`             | 更新一个已存在会话的配置（热；目前只支持切换 `selection` 指定的模型，见 §8）      |
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

不是方法调用，是服务端在 `session.subscribe()` 建立订阅后主动推送的消息，`sessionId` 相关的会话事件都从这里多路复用地推过来（`fs` 是只读模块，不产生变化事件；`pty` 输出流是否也复用这条通道还没设计，见 §8）。完整的订阅、心跳、背压丢帧恢复、断线重连时序见配套架构图（文档开头链接）里的 frame ②「events 订阅时序图」。

三条不做在文字里重复、直接看图的机制：`seq` 单调递增、`gap` 丢帧合并、断线重连和背压丢帧走同一套"整个重新拉快照"逻辑，不做续传。另外两条图上不方便体现的设计决策：

- 服务端允许多个 WS 连接同时接入（比如 CLI 和 Web UI 同时连着同一个 Server），所有连接共享同一份广播事件流，不按连接过滤，这跟 OpenCode 多 UI 场景一致。
- 同一个 session 被多个客户端同时发起热操作（比如两边都调 `prompt`）时，不额外设计"连接级别加锁"，完全交给 `SessionLifecycle` 的不变量兜底——具体失败形式属于错误契约，这里不展开（见 §8）。

> 参考实现：neo-monorepo `packages/server/.../session-event-hub.ts`；`getSnapshot` 在参考实现里叫 `getSessionSnapshot`，我们这边简化了方法名。

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
| `project.remove` | 删除项目（`playground` 项目受保护，不可删） |

会话是否归档是 `session` 模块自己的概念（`session.archive` + `session.list` 返回的摘要里带 `archived` 字段），不需要在 `project` 模块另开一个按项目分组的批量查询接口；"置顶会话""折叠的分组"是纯客户端本地展示状态，不属于 harness agent runtime 的领域模型，这套 runtime 不管。

### 4.7 skill 模块

每个 harness agent 后端都有自己的一套 skills 实现（装什么、怎么装、怎么启动都是后端自己的事），这里先只列出模块和方法名，具体机制不细化（见 §8 待办）。

| 方法                     | 说明                             |
| ---------------------- | ------------------------------ |
| `skill.list`           | 列出某个 harness agent 已安装的 skills |
| `skill.install`        | 给某个 harness agent 安装一个 skill   |
| `skill.enable/disable` | 启动/激活某个 skill                  |

### 4.8 provider 模块

一个会话用哪个 LLM（哪个 provider、哪个 model）不是 agent 后端自己决定的，是这层 runtime 管的——支持内置 provider（预置好协议/endpoint，用户只需要填凭证）和用户自己配置的自定义 provider（任意 baseURL、任意 OpenAI-compatible 协议端点等），这属于"模型配置"；跟"模型市场"（可发现/浏览的第三方 provider 目录）是两回事，后者本设计不做（见 §1）。

| 方法                    | 说明                                                                   |
| --------------------- | -------------------------------------------------------------------- |
| `provider.list`       | 列出已配置的 provider（内置 + 自定义），可选按某个 `harnessAgentId` 过滤出协议兼容的            |
| `provider.listModels` | 列出某个/所有 provider 下的模型                                                |
| `provider.configure`  | 新增/更新一个 provider（含凭证）；已知的内置 id 只能覆盖凭证和启用状态，未知 id 就是一个全新的自定义 provider |

`session.create` 因此多一个可选参数 `selection?: ModelSelection`（见 §5.1）；没有全局默认选择的概念了，解析顺序是"显式传入 > adapter 自己的零配置默认值"，由 §5.2 `ModelProviderService` 解析成一份 `ResolvedModelConfig` 交给 adapter 使用。

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

Controller 只做参数校验和响应组装，业务逻辑全部在 Service 层；具体实现类按 Egg.js 约定放在 `app/service/xxx.ts`，Controller 里通过 `ctx.service.xxx` 访问。下面按角色列出每个抽象/Service 和它们的依赖关系，不逐个方法展开。

命名约定：凡是会被其他 Service/类型依赖注入的协作对象，都先定义一个 `IXxx` 接口，再有一个去掉 `I` 前缀、同名的实现类（比如 `IProjectRepository` / `ProjectRepository`）——依赖关系一律按接口类型声明，方便以后测试替换成 mock 实现；纯数据形状（DTO，比如 `ModelSelection`）、以及只有一份实现且不被其他地方按接口依赖的内部细节（比如 `SessionLifecycle`），不强制加接口，下表里用"—"标出。

### 5.1 核心类型与接口

| 接口 | 实现类 | 角色 |
|---|---|---|
| — | `HarnessAgentId` | `'claude-code' \| 'codex'`，统一标识 agent 后端；纯数据形状，不需要接口 |
| `IHarnessAgentAdapter` | `ClaudeCodeAdapter`、`CodexAdapter` | 每个后端各自实现的统一驱动接口：可用性检查、（可选）登录、创建/恢复/关闭活跃会话、持有一份 `ISessionRepository`、一份 `ISkillRepository`、一份 `IMcpConfigWriter` |
| `IHarnessAgentRegistry` | `HarnessAgentRegistry` | 持有构造时传入的 `IHarnessAgentAdapter` 数组，提供 `list()`/`get(id)`/`status()`/`dispose()`（挨个调用每个 adapter 的 `dispose?()`）；是 `harness` 模块的实现，本身不做业务编排，其余 Service 依赖它做 adapter 查询——没有归进 §5.2，因为除了持有构造时传入的数组之外没有别的依赖，更接近一个类型/容器而不是编排型 Service |
| `IHarnessAgentSession` | `ClaudeCodeSession`、`CodexSession` | 一个活跃会话的运行时接口（`prompt`/`interrupt`/`close`/`getStatus`/`getSnapshot`/`respondToAgentRequest`），内部持有一个 `SessionLifecycle` |
| `IHarnessAgentSessionManager` | `HarnessAgentSessionManager` | 持有 `sessionId → IHarnessAgentSession` 的内存索引，提供 `register`/`get`/`remove`；纯内存态、不持久化（见 §5.3），进程重启后这份索引直接清空，客户端需要重新调 `session.resume` 才能拿回活跃实例。和 `HarnessAgentRegistry` 一样只是持有集合、没有业务编排，归进 §5.1 而不是 §5.2；管的是"活跃会话实例"，跟 `HarnessAgentRegistry` 管"HarnessAgent 后端本身的可用性/状态"是两个维度，别搞混 |
| `ISessionRepository` | 各后端各自实现（未单独命名） | 每个后端自己历史会话的冷存储接口（`list`/`rename`/`delete`/`archive`/`getMessages`），对应 `session` 模块里"冷"的那部分方法；实际存储由 harness agent 后端自己管，我们的 runtime 不设计它的格式，见 §5.3 |
| — | `SessionLifecycle` | 每个活跃会话一个实例，保证"一个 turn 有始有终、一个 `agent_request` 恰好被处理一次、结束后不再发事件"这几条不变量；只有一份共用实现、不跨后端多态，不需要接口 |
| `ISkillRepository` | 各后端各自实现（未单独命名） | 每个后端自己的 skills 安装/启动/列举实现，对应 `skill` 模块；实际内容统一装在 `~/.agents/skills/<name>/` 下，每个后端通过软链接接入自己期望的目录，见 §5.3；安装来源、和 session 的关系还没设计（见 §8） |
| `IMcpConfigWriter` | 各后端各自实现（未单独命名） | 每个后端自己把 `ResolvedMcpServerConfig` 翻译成原生格式、写进自己配置文件的实现（`enable`/`disable`），对应 `mcp` 模块；跟 `ISessionRepository`/`ISkillRepository` 一样是"每个后端自己懂自己的格式"，`McpService` 不关心具体怎么写，只负责编排，见 §5.3 |
| `IProjectRepository` | `ProjectRepository` | `$NEO_HOME/storage/projects.json` 的读写接口（原子写，见 §5.3），只做数据存取，不做业务规则 |
| `IProviderRepository` | `ProviderRepository` | `$NEO_HOME/config.json` 里 `provider` 字段的读写接口（原子写，见 §5.3），只做数据存取，不做业务规则 |
| `IMcpRepository` | `McpRepository` | `$NEO_HOME/config.json` 里 `mcp` 字段的读写接口（原子写，见 §5.3），只做数据存取，不做业务规则 |
| — | `ModelSelection` | `{ providerId, modelId }`，会话创建时对模型的显式选择，对应 `provider` 模块（§4.8）；纯数据形状，不需要接口 |
| — | `ResolvedModelConfig` | 解析后的最终模型配置（`model`/`provider`/`baseURL`/`authToken`），由 `ModelProviderService` 产出、交给 adapter 用；纯数据形状，不需要接口 |
| — | `ResolvedMcpServerConfig` | 解析后的 MCP server 连接参数（stdio：command/args/env；或 remote：url + 凭证），`enable` 时由 `McpService` 产出，用来生成写进目标 harness agent 原生配置文件的具体内容；纯数据形状，不需要接口 |
| `IPtyManager` | `PtyManager` | 持有 `ptyId → 具体 pty 进程句柄` 的内存索引，提供 `register`/`get`/`remove`；纯内存态、不持久化（见 §5.3）；跟 `HarnessAgentSessionManager` 同一个模式 |

工具审批（`respondToAgentRequest`）走的是"session 收到原生请求 → 存一个待处理的 resolver、经 `SessionLifecycle.emit` 推事件通知客户端 → 客户端响应时找到 resolver、翻译回原生协议、触发它、标记为已解决"这条路径；`SessionLifecycle` 负责在会话结束/崩溃时把没处理完的请求兜底标记掉，避免永远挂起。

### 5.2 Services 与依赖关系

| 接口 | 实现类 | 职责 | 依赖 |
|---|---|---|---|
| `IHarnessAgentSkillService`   | `HarnessAgentSkillService`   | skills 安装/启动/列举（细节未设计），`skill` 模块的实现                                                                                 | `IHarnessAgentRegistry`（§5.1）                                                |
| `IHarnessAgentSessionService` | `HarnessAgentSessionService` | 统一对外服务（`create`/`list`/`resume`/`prompt`/`configure`/...），`session` 模块核心实现；会话生命周期编排逻辑在这，活跃实例的存取委托给 `IHarnessAgentSessionManager` | `IHarnessAgentRegistry`（§5.1）、`IHarnessAgentSessionManager`（§5.1）、`IEventBus`、`IModelProviderService` |
| `IModelProviderService`       | `ModelProviderService`       | provider/model 配置的增删改查、凭证管理，把一次 `ModelSelection` 解析成 `ResolvedModelConfig`，`provider` 模块的实现                          | `IProviderRepository`（§5.1）                                                  |
| `IMcpService`                 | `McpService`                 | `mcp` 模块的实现（细节未设计，见 §8）；`enable`/`disable` 时用 `IHarnessAgentRegistry` 查到目标 adapter，调它的 `IMcpConfigWriter.enable/disable`——具体怎么翻译成原生格式、写到哪个文件，是每个 adapter 自己的事，`McpService` 只做编排，跟 `session` 生命周期没有交互 | `IMcpRepository`（§5.1）、`IHarnessAgentRegistry`（§5.1）                        |
| `IEventBus`                   | `EventBus`                   | 事件枢纽：会话事件统一从这里推送，含背压丢帧提示（`gap`）、心跳（`ping`），支持多个并发订阅连接（广播，不按连接过滤）                                                     | 无（共享单例）                                                                     |
| `IFSService`                  | `FSService`                  | `fs` 模块实现（只读：readFile/tree/grep/search）                                                                              | 无                                                                           |
| `IGitService`                 | `GitService`                 | `git` 模块实现；Service 层写操作方法齐全，只对外暴露只读子集（见 §8）                                                                          | 无（仅一个日志 sink）                                                               |
| `IProjectService`             | `ProjectService`             | `project` 模块实现，另有 `findById`/`update` 等内部方法未对外暴露；实际读写落地在 `IProjectRepository`（见 §5.3），自己只做 `playground` 保护、路径去重这类业务规则 | `IProjectRepository`（§5.1）                                                   |
| `IPtyService`                 | `PtyService`                 | `pty` 模块的实现（细节未设计）；活跃 pty 实例的存取委托给 `IPtyManager`                                                                        | `IPtyManager`（§5.1）、`IEventBus`                                                    |

`HarnessAgentSessionService` 不依赖 `ProjectService`——`workspacePath` 由 Controller 用 `ProjectService.findById` 解析好之后再传进来。活跃会话的 `sessionId → HarnessAgentSession` 索引由 `HarnessAgentSessionManager`（§5.1）维护，调用方一个 `sessionId` 就能定位会话，不用额外带上 `harnessAgentId`。`create` 时 `HarnessAgentSessionService` 先把调用方传入的 `ModelSelection`（可选）丢给 `ModelProviderService` 解析成 `ResolvedModelConfig`，再连同 `workspacePath` 一起交给 `HarnessAgentRegistry` 查到的 adapter 的 `createSession`，拿到返回的 `HarnessAgentSession` 实例后调用 `HarnessAgentSessionManager.register()` 存进索引；`close` 时则是先按 `sessionId` 从 `HarnessAgentSessionManager.get()` 取出实例、调用它的 `close()`，再 `HarnessAgentSessionManager.remove()` 把索引里的条目摘掉。

### 5.3 数据存储

存储格式和文件读写只属于 `ProjectRepository`/`ProviderRepository`/`McpRepository`（§5.1）——`ProjectService`/`ModelProviderService`/`McpService` 不直接碰文件，只调用各自 Repository 的存取方法，业务规则（`playground` 保护、凭证解析等）留在 Service 层。`$NEO_HOME` 未设置时默认 `~/.neo——环境变量名对齐参考实现，但默认目录名换成这套独立实现自己的，不复用参考实现的 `~/.neo-desktop`，避免两边同时装在一台机器上互相踩到对方的数据。

| 文件 | 归属 Repository | 格式 |
| --- | --- | --- |
| `$NEO_HOME/storage/projects.json` | `ProjectRepository` | 单文件 JSON，整体读写，只存 `Project[]`——不像参考实现那样把 `archivedSessions`/`pinnedSessions`/`closedProjectAccordions` 等也塞进同一个文件；这些字段要么已经挪到别处（`archived` 归 `session` 模块自己管，见 §4.6），要么本来就不该持久化（`pinned`/折叠分组是纯 UI 本地状态，见 §1） |
| `$NEO_HOME/config.json`（`provider` 字段） | `ProviderRepository` | provider 属于"配置"性质的数据，不单独开一个文件，跟参考实现一样放进一份整体配置文件里的 `provider` 字段——内置 provider 的覆盖项、自定义 provider、凭证（`apiKey` 等）都在这个字段里，不单独拆分（凭证同文件存放，见 §8 关于文件权限的待办） |
| `$NEO_HOME/config.json`（`mcp` 字段） | `McpRepository` | mcp server 配置，跟 `provider` 同理归进这份整体配置文件，不单开文件；remote 类型的凭证也同文件存放，见 §8 关于文件权限的待办 |

`projects.json` 在 `storage/` 子目录下，`config.json` 直接放在 `$NEO_HOME` 根下，不跟着进 `storage/`——两者语义不同：前者是一份数据集合，后者是单份整体配置，这也是参考实现里 `config.json` 本来的位置。两个文件都采用"写临时文件 + 原子 rename"的更新方式（参考实现同样如此），避免进程崩溃导致文件写到一半、内容损坏。`config.json` 目前只放 `provider`/`mcp` 这两个字段，没有引入其他通用应用配置（见 §1 的范围排除）。

会话历史不在这套约定里——`SessionRepository` 只是个接口，实际存储完全由每个 harness agent 后端自己管，我们的 runtime 不碰、也不设计它的格式。参考实现里 claude-code 是 `~/.claude/projects/<project>/<sessionId>.jsonl`（每个 session 一个文件，一行一条记录），codex 是 `~/.codex/sessions/` 下的 rollout jsonl + 一个 `codex.db` SQLite 索引，而且服务端从不直接读写这些文件，只通过 codex app-server 的 RPC（`thread/list`/`thread/read` 等）间接访问；两边都是各自 CLI 的黑盒。

`skill` 内容统一装在 `~/.agents/skills/<name>/` 下——不在 `$NEO_HOME` 下，因为这是 agent 生态共享的东西，不是这套 runtime 私有的数据。每个 harness agent 后端需要用到某个 skill 时，在自己期望的目录下建一个软链接指向它（比如 claude-code 的 `.claude/skills/<name>`、codex 的 `.codex/skills/<name>`），避免每个后端各自拷贝一份内容。`skill.install` 具体怎么把内容下载/复制进 `~/.agents/skills`、软链接是全局建一次还是每个 project 各建一份，这些还没设计（见 §8）。

`pty` 会话不持久化——纯内存状态，进程重启即丢失；参考实现里也没有 PTY 持久化，这符合"伪终端天然是易失的"这个直觉。

> 参考实现：neo-monorepo `packages/server/src/features/project/store.ts`（projects.json + 原子写）、`packages/server/src/features/config/service.ts`（provider 配置 + 凭证同文件）、`packages/server/src/features/agent/providers/{claude-code,codex}/*session-repository.ts`（会话历史委托给 adapter 原生存储）。

### 5.4 核心接口定义（session 相关）

§4.2 里每个 `session.*` 方法具体落在哪个类型上，把下面这几个核心接口的方法签名写清楚就不用再猜：

```typescript
// ---- Registry：管 HarnessAgent 后端本身的可用性/状态，不碰会话 ----
interface IHarnessAgentRegistry {
  list(): IHarnessAgentAdapter[];
  get(id: HarnessAgentId): IHarnessAgentAdapter | undefined; // 冷操作路由要用，见下面
  status(id: HarnessAgentId): Promise<{ available: boolean; reason?: string }>;
  dispose(): Promise<void>; // 挨个调用每个 adapter 的 dispose?()
}

// ---- Adapter：每个后端各自实现的统一驱动接口 ----
interface IHarnessAgentAdapter {
  readonly id: HarnessAgentId;
  readonly sessionRepository: ISessionRepository;
  readonly skillRepository: ISkillRepository;
  readonly mcpConfigWriter: IMcpConfigWriter;

  checkAvailability(): Promise<{ available: boolean; reason?: string }>;
  login?(): Promise<unknown>; // 机制未定，见 §8
  createSession(config: { workspacePath: string; model: ResolvedModelConfig }): Promise<IHarnessAgentSession>;
  resumeSession(sessionId: string): Promise<IHarnessAgentSession>;
  dispose?(): Promise<void>; // 比如 CodexAdapter 杀掉常驻 app-server 子进程
}

// ---- McpConfigWriter：每个后端自己把配置翻译成原生格式、写进自己配置文件的实现 ----
interface IMcpConfigWriter {
  enable(server: ResolvedMcpServerConfig): Promise<void>;
  disable(serverId: string): Promise<void>;
}

// ---- Session：一个活跃会话的运行时接口 ----
interface IHarnessAgentSession {
  readonly id: string; // 格式 `${harnessAgentId}:${uuid}`，见下面路由说明
  prompt(input: { text: string }): Promise<void>;
  interrupt(): Promise<void>;
  close(): Promise<void>;
  getStatus(): Promise<SessionStatus>;
  getSnapshot(): Promise<SessionSnapshot>; // 消息+状态+元数据，直接读内存，不查 ISessionRepository
  respondToAgentRequest(requestId: string, response: AgentRequestResponse): Promise<void>;
  configure(config: { model?: ResolvedModelConfig }): Promise<void>; // 目前只支持切换模型，见 §8
}

// ---- SessionManager：管活跃实例的内存索引，不做业务编排 ----
interface IHarnessAgentSessionManager {
  register(session: IHarnessAgentSession): void;
  get(sessionId: string): IHarnessAgentSession | undefined;
  remove(sessionId: string): void;
}

// ---- SessionRepository：每个后端自己历史会话的冷存储接口 ----
interface ISessionRepository {
  list(): Promise<SessionSummary[]>;
  getMessages(sessionId: string): Promise<Message[]>;
  rename(sessionId: string, name: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
}

// ---- SessionService：对外统一门面，session 模块的实现 ----
interface IHarnessAgentSessionService {
  list(): Promise<SessionSummary[]>;
  subscribe(sessionId?: string): AsyncIterable<SessionEvent>;
  create(input: { projectId: string; harnessAgentId: HarnessAgentId; selection?: ModelSelection }): Promise<{ sessionId: string }>;
  resume(sessionId: string): Promise<void>;
  configure(sessionId: string, config: { selection?: ModelSelection }): Promise<void>;
  prompt(sessionId: string, input: { text: string }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  respondToAgentRequest(sessionId: string, requestId: string, response: AgentRequestResponse): Promise<void>;
  getStatus(sessionId: string): Promise<SessionStatus>;
  getMessages(sessionId: string): Promise<Message[]>;
  getSnapshot(sessionId: string): Promise<SessionSnapshot>;
  rename(sessionId: string, name: string): Promise<void>;
  archive(sessionId: string): Promise<void>;
  delete(sessionId: string): Promise<void>;
  close(sessionId: string): Promise<void>;
}
```

`SessionSummary`/`Message`/`SessionStatus`/`SessionSnapshot`/`SessionEvent`/`AgentRequestResponse` 只是占位类型名，具体字段没有展开设计（事件 payload 见 §8）。

上一轮追出来的"冷操作怎么路由到具体 adapter"的洞，这里给一个解法并落到接口里：`create`/`resume` 生成的 `sessionId` 格式定为 `${harnessAgentId}:${uuid}`（`IHarnessAgentSession.id` 那行的注释）；`IHarnessAgentSessionService` 的 `getMessages`/`rename`/`archive`/`delete` 这几个冷方法，拿到 `sessionId` 后先切出前缀部分的 `harnessAgentId`，用新加的 `IHarnessAgentRegistry.get(id)` 查到对应 adapter，再调 `adapter.sessionRepository.<method>(sessionId)`——不需要额外的路由表，也不用调用方多传一个 `harnessAgentId` 参数。这是本设计对上一轮那个洞给出的具体方案，如果不想用 ID 编码前缀这个办法，需要另外讨论。

mcp server 不在 `createSession` 的参数里——`enable` 时已经把配置写进了 harness agent 自己的原生配置文件，adapter 拉起进程时会自己读到，`session` 这条链路不用管（见 §4.10）。`configure` 走的是类似 `create` 的路：`IHarnessAgentSessionService.configure(sessionId, { selection })` 把新的 `ModelSelection` 解析成 `ResolvedModelConfig`，从 `IHarnessAgentSessionManager` 找到活跃实例，调它的 `configure({ model })`——具体这个模型切换在一次正在进行的 turn 中途调用会发生什么（比如是否要等当前 turn 结束、要不要打断），adapter 层怎么落地，都还没设计，见 §8。

## 6. 装配根与依赖图

服务端启动时由一个装配根统一 `new` 出所有 Service 单例，再传给各 Controller/Router；下面代码里 `new` 的都是具体实现类，构造函数参数的类型按 §5.1/§5.2 表里的接口（`IXxx`）声明：

```typescript
class HarnessAgentServerFeatures {
  readonly projectRepository = new ProjectRepository();
  readonly project = new ProjectService({ repository: this.projectRepository });
  readonly git = new GitService({ warn, debug });
  readonly events = new EventBus();
  readonly fs = new FSService();
  readonly harnessAgentRegistry = new HarnessAgentRegistry([
    new ClaudeCodeAdapter(),
    new CodexAdapter(),
  ]);
  readonly harnessAgentSessionManager = new HarnessAgentSessionManager();
  readonly providerRepository = new ProviderRepository();
  readonly provider = new ModelProviderService({ repository: this.providerRepository });
  readonly mcpRepository = new McpRepository();
  readonly mcp = new McpService({ repository: this.mcpRepository, registry: this.harnessAgentRegistry });
  readonly harnessAgentSession = new HarnessAgentSessionService({
    registry: this.harnessAgentRegistry,
    sessionManager: this.harnessAgentSessionManager,
    events: this.events,
    provider: this.provider,
  });
  readonly harnessAgentSkill = new HarnessAgentSkillService({
    registry: this.harnessAgentRegistry,
  });
  readonly ptyManager = new PtyManager();
  readonly pty = new PtyService({ manager: this.ptyManager, events: this.events });

  async dispose() {
    await this.harnessAgentRegistry.dispose();
    this.events.dispose();
  }
}
```

依赖关系见 §5.2；这里补一点 §5.2 没提到的：`EventBus` 是装配根构造的共享单例，注入给 `HarnessAgentSessionService`，`PtyService` 也依赖它来推送终端输出，但具体怎么复用还没设计（见 §8）。

真正持有需要清理的资源（子进程）的是 `HarnessAgentRegistry`——它的 `dispose()` 会挨个调用每个 adapter 的 `dispose?()`（比如 `CodexAdapter` 需要杀掉常驻的 `codex app-server` 子进程）；`EventBus.dispose()` 负责停掉 ping 定时器、清空订阅队列；`HarnessAgentSessionService` 和它依赖的 `HarnessAgentSessionManager` 自己都不持有任何需要显式释放的资源，不需要 `dispose()`——`HarnessAgentSessionManager` 里存的 `HarnessAgentSession` 实例背后即使包着子进程句柄，那份资源的释放也是靠 `HarnessAgentSessionService.close()` 先调实例的 `close()`，`HarnessAgentSessionManager.remove()` 只是摘除索引引用，不负责释放资源；`ProjectService`/`GitService`/`ModelProviderService`/`FSService`（以及 `ProjectRepository`/`ProviderRepository`）都是无状态的按次文件/进程 I/O，进程退出即释放，同样不需要清理；`PtyManager` 直接持有存活的 shell 子进程句柄（不像 `HarnessAgentSessionManager` 那样只是摘引用），需要自己的 `dispose()` 来清理，但接口方法和装配根里的调用都还没补上（见 §8）。

## 7. 鉴权

未配置密码环境变量时不做任何校验；配置了密码后，在 WS 握手阶段校验 `Authorization: Basic` header（或 query token），校验失败拒绝升级连接。

## 8. 待办事项

- `sessionId` 用 `${harnessAgentId}:${uuid}` 前缀编码来解决冷操作路由（见 §5.4）——这是目前给出的具体方案，还没有验证这个格式会不会跟某个后端自己的原生会话 ID 格式冲突，也没考虑要不要对客户端暴露这个内部编码细节（比如要不要在协议层面当它是不透明字符串处理）。
- `$NEO_HOME/config.json` 里的凭证（`provider`/`mcp` 两个字段都可能有）目前跟其余配置存在同一个文件、没有做文件权限收紧（比如 `chmod 600`）——参考实现里同样没做，但这套 runtime 要不要主动补上这个小的安全加固，还没决定。
- `EventBus` 的背压阈值（相当于"缓冲队列上限"）、ping 间隔、gap 之后客户端具体怎么补状态，这几个数值/流程还没敲定，需要确认。
- Egg.js 应用作为 Bun workspace 成员运行是否有兼容性问题（`egg-bin dev`/cluster 机制依赖真实 Node 运行时）需要验证。
- 类型定义手动同步的维护成本——后续要不要收敛成一个共享的轻量 types 包，现在先不做。
- `git` 模块的写操作（`checkout`/`createBranch`/`switchBranch` 等）Service 层已经实现，但故意没有注册成 API——需要确认是否真的不需要对外开放。
- `git` 模块目前只保留 `status`/`branch` 两个方法，是临时简化——`isGitRepo`/`currentBranch`/`isGitWorktree`/`getContributors`/`getCommitStats`/`getActivityData`/`getRecentActivity`/`getConfig`/`getProjectGitInfo` 这些先不设计，要不要加回来、加哪些，还没决定；`git.branch` 里"查默认分支"具体传什么参数也还没定。
- `fs` 模块没有路径越界保护，是否要限制在某个 `project.path` 白名单内、防止越权访问宿主机任意路径，需要确认。
- `fs.grep`/`fs.search` 的具体参数（大小写/正则开关、结果数量上限与分页、是否遵守 `.gitignore`、`fs.tree` 的递归深度限制）还没设计。
- `HarnessAgentSession` 目前只定义了 v1 必须的方法（prompt/interrupt/close/getStatus/getSnapshot/respondToAgentRequest/configure）；像"回退到某条历史消息重新生成"、"从某条消息分叉出一个新会话"这类进阶能力，哪些 adapter 支持、要不要在 v1 就设计成可选方法，还没决定。
- `skill` 模块目前只有方法名占位（`list`/`install`/`enable/disable`）——`skill.install` 具体从哪下载/复制内容（本地目录、远程 registry、还是别的）、软链接是全局建一次还是每个 project 各建一份、和 session 是什么关系（会话级还是全局级生效）、每个后端（claude-code/codex）的 skill 格式是否统一，这些都还没设计；存储位置本身已经定了（`~/.agents/skills/<name>` + 软链接进各后端目录，见 §5.3）。
- `harness.login` 目前也只是占位——各 harness agent 后端登录方式差异很大（OAuth 网页授权、CLI 粘贴 API key、已经有 env var 直接免登录等）；尤其 OAuth 这类需要打开浏览器的流程，在服务端是远程运行的场景下要怎么处理（返回一个 URL/code 让客户端在用户本机打开？）还没设计。
- 事件信封（envelope）没有给出具体字段结构的示例——§4.3 只定义了 `kind` 的取值，一条 `turn_started` 之类的事件实际长什么样，需要补一个典型 payload 示例。
- RPC 方法调用本身要不要超时/取消语义，还没设计——注意这跟 `interrupt`（取消的是 agent turn）是两回事。
- §7 鉴权目前只覆盖连接层（Basic Auth），但 `fs`/`git` 能读取宿主机文件系统，信任边界比"连上了就行"更大；这条要跟"fs 没有路径越界保护"那条待办一起考虑，鉴权章节需要明确写清楚这是两层不同的东西。
- `project.remove` 里提到的 `playground` 项目目前只说了"受保护不可删"，具体是什么（默认占位项目？没接入真实仓库时的兜底项目？）没有解释，需要补一句说明。
- §3 提到"同一个 session 被多个客户端同时发起热操作时，交给 `SessionLifecycle` 的不变量兜底，具体失败形式属于错误契约"——这个错误契约本身还没设计（后到的调用是直接报错、排队等待、还是覆盖前一个），`IHarnessAgentSession` 各方法要不要抛出特定错误类型也取决于这条，目前还是空的。
- `provider.configure` 目前没有凭证校验（比如新配的自定义 provider 到底能不能连通）——参考实现里这块也没做真正的网络探测，只是"填了 apiKey 就认为 ready"，要不要在这套 runtime 里加一个真正探测的 `testCredential` 方法，还没决定。
- 去掉全局默认 provider+model 选择之后，`session.create` 不传 `selection` 就完全依赖 adapter 自己的零配置默认值——每个 adapter（claude-code/codex）零配置状态下到底用哪个 model，需不需要一个 fallback 机制，还没设计。
- `provider.list` 里"按 `harnessAgentId` 过滤协议兼容的 provider"具体怎么判断兼容（比如某个 adapter 只支持特定协议家族）——`HarnessAgentAdapter` 目前没有声明自己支持哪些协议，这条过滤逻辑要不要做、怎么做还没设计。
- `pty` 模块目前只有方法名占位——`pty.update` 具体覆盖哪些操作（resize、写输入、还是别的）没有设计；pty 的输出流怎么推送给客户端（复用 §4.3 events 通道还是别的机制）没有设计（`PtyManager` 已经确定持有真实的子进程句柄而不是纯索引引用，`IPtyService` 依赖 `IEventBus` 也已经在 §6 装配根里定下来了，这两点不再是待定项，只是具体的推送机制还没设计）；pty 进程的生命周期管理（比如客户端断线后要不要自动清理、有没有超时策略）也没有设计；`PtyManager.dispose()` 该做什么清理、接口方法长什么样还没写出来，§6 装配根示例代码里的 `dispose()` 目前也漏了调用它，需要补上。
- `mcp` 模块目前只有方法名占位（`mcp.server.create`/`list`/`enable/disable`）——stdio（command/args/env）和 remote（url + 凭证）两种 MCP server 配置形态怎么用一个 schema 统一表达没有设计；`mcp.server.update`/`mcp.server.remove`/列出某个 server 暴露的工具（类似 `provider.listModels`）先不设计。`enable` 把 `ResolvedMcpServerConfig` 翻译成每个后端原生格式（claude-code 的 `.mcp.json`、codex 的 `config.toml`）这份能力已经定为每个 adapter 自己实现（`IMcpConfigWriter`，见 §5.1/§5.4），但每个后端具体怎么翻译还没设计；配置文件是项目级（比如 claude-code 的 `.mcp.json` 通常放在项目根目录）还是用户级，`enable` 要不要传 `workspacePath`，这条待办跟 `skill` 那条"软链接全局建一次还是每个 project 各建一份"是同一类问题，没有一起解决；`enable` 要不要实际连接做健康检查/超时处理也没考虑。
- `session.configure` 目前只支持切换 `selection` 指定的模型（见 §5.4）——在一次正在进行的 turn 中途调用会发生什么（等当前 turn 结束、还是打断）没有设计；每个 adapter（claude-code/codex）底层到底支不支持运行时切换模型也没有确认；以后要不要扩展 `configure` 去覆盖别的会话级配置（而不是新开更多方法），还没决定。

## 9. React 状态管理层（`neo-harness-agent-react`）

`packages/neo-harness-agent-react`（`@alipay/neo-harness-agent-react`）——依赖 §2 的客户端 SDK，不直接碰 WS。目的：把"建连、订阅事件、断线重连补快照"这套 §3 里手写的样板逻辑封装掉，业务代码只用 hook 读状态、调用几个 action，不用自己维护订阅循环和 reducer——即"根据状态渲染 UI"。

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

这一层不重新设计 §4 的方法/协议，纯粹是"client SDK → 好用的 React hook"的薄封装。具体 reducer 细节（比如收到 `gap` 事件要不要先清空消息缓存再重新拉快照、`pendingAgentRequests` 怎么在 UI 层触发审批弹窗、`useSessionList` 的 `projectId` 过滤要不要等 §8 里 `ISessionRepository` 的项目维度设计定了再做）都还没细化，算是这个包自己的待办，不并入 §8。
