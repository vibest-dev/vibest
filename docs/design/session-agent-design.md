# Server 架构 Agent 部分设计

> 本文是内部设计稿的脱敏副本，作为 `docs/wayfinder/session-streaming-refactor/` 重构的源设计留档。命名已对齐 vibest（server / `$VIBEST_HOME`）；vibest 的实际取舍（保留 oRPC 而非 JSON-RPC、主动 getSnapshot、两维订阅、仅 session 事件带 seq 等）以 wayfinder map 的既定约束为准。
>
> 状态：v1 设计稿，等待实现验证。
>
> 本文只记录 v1 的外部契约、关键不变量和服务端模块边界。第三方源码对照、被否决方案和未来 Agent 调研不属于本文。
>
> 配套架构图（事件时序图）为内部资产，未随本副本收录；事件时序以本文 §7 为准。

## 1. 目标与范围

本文设计 Server 架构中的 Agent 子系统：

- Server 托管 Agent 会话、项目、只读文件系统、只读 Git 和模型配置。
- Server client 通过一条 WebSocket 连接，以 JSON-RPC 2.0 调用方法并订阅事件。
- React 状态层在 Server client 之上维护可直接渲染的状态。
- 会话历史仍由各 Agent 的原生存储负责；Server 只保存路由和模型选择等薄元数据。

### 1.1 v1 支持范围

v1 支持两个 Agent：

```typescript
type HarnessAgentId = "claude-code" | "codex";
```

v1 对外提供七个模块：

- `harness`：Agent 列表和可用性。
- `session`：会话生命周期、消息、配置、审批和历史。
- `global`：会话集合事件。
- `project`：用户打开过的项目目录。
- `fs`：受工作区边界约束的只读文件能力。
- `git`：只读 Git 信息。
- `provider`：Provider、模型和凭证引用配置。

### 1.2 v1 不做

以下能力不进入 v1 对外契约：

- OpenCode、Pi 支持。
- skills、MCP 和 PTY 管理。
- Agent 登录流程。
- 文件或图片消息。
- Git 写操作。
- 文件写入和文件监听。
- 会话回退、重新生成、分叉。
- 外部原生会话自动导入。
- 模型市场和第三方 Provider 发现。
- 置顶、折叠、主题等纯客户端展示状态。

## 2. 基本用法

典型调用顺序是：创建或选择 Project、创建 Session、订阅 Session 流、发送消息。

```typescript
const client = createServerClient({
  url: "ws://127.0.0.1:7001",
  headers: {
    Authorization: `Basic ${Buffer.from("user:password").toString("base64")}`,
  },
});

const { harnessAgents } = await client.harness.list();
const project = await client.project.create({
  cwd: "/Users/me/work/my-project",
});
const ref = await client.session.create({
  projectId: project.id,
  harnessAgentId: "claude-code",
});

// subscribe 原子返回运行时快照；新订阅在 response 后先收到
// 当前 active turn 的 UIMessageChunk replay，再接入 live 事件。
const subscription = await client.session.subscribe(ref);
const { messages: committedMessages } = await client.session.getMessages(ref);

const state = initializeSessionState({
  snapshot: subscription.snapshot,
  committedMessages,
});

await client.session.prompt(ref, { text: "修复登录问题" });

for await (const event of subscription.events) {
  state.apply(event);

  if (event.type === "session.turn.ended") {
    const { messages } = await client.session.getMessages(ref);
    state.mergeCommittedMessages(messages);
    break;
  }
}

await subscription.unsubscribe();
```

`initializeSessionState`、`state.apply` 和 `state.mergeCommittedMessages` 只是 Renderer 合并策略的本地伪代码，不是 wire API。Server client 可以把 `SessionRef` 与方法参数分开；wire 上的 RPC 参数使用本文定义的完整输入类型。

## 3. 核心概念

### 3.1 核心存储目录

`$VIBEST_HOME` 缺省为 `~/.vibest`。Server 自己维护三个核心存储位置：

```text
$VIBEST_HOME/
├── storage/
│   ├── projects.json
│   └── sessions/
│       └── <projectId>/
│           └── <sessionId>.json
└── models.json
```

| 路径                                                         | 真相源内容                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| `$VIBEST_HOME/storage/projects.json`                         | Project 列表；唯一的 `projectId -> cwd` 映射                     |
| `$VIBEST_HOME/storage/sessions/<projectId>/<sessionId>.json` | 单个 Session 的元数据；保存原生会话映射和恢复所需的 Session 配置 |
| `$VIBEST_HOME/models.json`                                   | Provider、模型目录和凭证环境变量引用                             |

```typescript
type ProjectsFile = {
  version: 1;
  projects: Project[];
};
```

#### Session 元数据目录

`$VIBEST_HOME/storage/sessions/<projectId>/` 是一个 Project 下的 **Session 元数据目录**。目录中的每个 `<sessionId>.json` 对应一个 Server Session。

例如：

```json
{
  "projectId": "0195b4b3-6dc4-7d41-a9ce-3ab5dcb6cc61",
  "harnessAgentId": "claude-code",
  "harnessSessionId": "4ec4fb44-50a7-4d91-a8bb-20fb77721b47",
  "config": {
    "providerId": "anthropic",
    "modelId": "claude-opus",
    "options": {
      "mode": "plan"
    }
  },
  "createdAt": "2026-07-08T10:00:00.000Z"
}
```

这个文件只保存 Server 恢复 Session 所需的最小信息：

```text
Server SessionRef
  -> Session 元数据文件
  -> Agent 类型与原生会话 ID
```

Session 元数据文件保存：

- 所属 projectId。
- 使用哪个 Agent。
- Agent 原生会话 ID。
- `config`：显式选择的 providerId/modelId（缺省表示使用 Agent 原生默认模型），以及用户显式设置过的运行时配置项 `options`。
- 创建时间。

这里的 `config` 是恢复会话所需的全部配置：providerId/modelId 表示模型路由；`options` 记录用户通过 `session.setConfigOption` 显式设置过的运行时配置（mode、effort 等，键为配置目录的 configId）。创建期不写入 `options` 初值——create 沿用 Agent 原生默认值或 nativeOptions；此后每次 setConfigOption/setModel 成功都同步写入本文件；resume 时读取并重放。

Session 元数据文件不保存：

- cwd：通过 `projectId -> projects.json -> Project.cwd` 获取。
- 对话消息和标题：由 Agent 原生存储负责。
- 当前状态、唯一的 active turn、pending request 和 active-turn `UIMessageChunk` 缓冲：只在内存中。

存储规则：

- Project 必须先于 Session 创建。
- 创建 Session 成功后新增元数据文件；setModel/setConfigOption 成功后同步更新 `config`；delete 时删除文件。
- close 只关闭活跃实例，不删除元数据文件。
- JSON 文件使用“临时文件 + fsync + rename”原子写入。

### 3.2 会话身份

所有 session 方法统一使用复合身份：

```typescript
type ProjectId = string; // UUID

type SessionRef = {
  projectId: ProjectId;
  harnessAgentId: HarnessAgentId;
  sessionId: string;
};
```

`projectId` 由 Server 生成 UUID，并映射到一个已登记 Project 的 `cwd`。所有 session 操作都以 `projectId` 为工作区依据；调用方不能在 session API 中直接传路径。

`sessionId` 由 Server 生成，是项目内的不透明 ID。Agent 原生 ID 不暴露为 wire 身份，而是保存在 Session 元数据文件中：

```text
SessionRef { projectId, harnessAgentId, sessionId }
  -> projects.json 中的 Project.cwd
  -> SessionMetadata.harnessSessionId
  -> Claude session UUID / Codex thread ID
```

`SessionRef` 的三个字段都必须原样传回：

- `projectId` 定位 Project 和 Session 元数据目录。
- `harnessAgentId` 选择 Agent 实现。
- `sessionId` 定位项目内的 Session 元数据文件。

### 3.3 Session 与 ProjectId

只有 Session 与 Project 强关联：

- `session.create`、`session.list` 接收 `projectId`。
- 其余 session 方法通过 `SessionRef.projectId` 定位 Project。
- Server 使用 projectId 找到 `Project.cwd`，再把 cwd 传给 Agent 原生 API。

Project 创建流程：

1. `project.create({ cwd })` 接收绝对路径。
2. 服务端规范化并校验 cwd。
3. 按规范化后的 cwd 去重。
4. 生成 UUID `projectId`。
5. 持久化 `{ id, name, cwd, createdAt }`。

未知 projectId 返回 `NOT_FOUND`。Project 是 Session 领域中 `projectId -> cwd` 的唯一映射来源；Session 元数据文件不复制 cwd。

其他环境能力不强制关联 Project：

- `fs.*` 继续显式接收 cwd 和相对路径。
- `git.*` 继续显式接收 cwd。
- draft PTY 继续显式接收 cwd。
- fs/git/pty 不查询 Project 数据。

### 3.4 历史、运行时与事件流

三类数据分别由不同组件负责：

| 数据                                         | 真相源                               |
| -------------------------------------------- | ------------------------------------ |
| 会话历史消息、标题                           | Agent 原生存储                       |
| projectId 到 cwd                             | `$VIBEST_HOME/storage/projects.json` |
| Server sessionId、原生 ID、Session 配置      | Session 元数据文件                   |
| 活跃状态、唯一的 active turn、挂起请求       | 服务端内存                           |
| 当前 turn 的 `UIMessageChunk` 缓冲和订阅队列 | 服务端内存                           |

服务端重启后：

- Agent 原生历史和 Session 元数据文件仍在。
- 活跃实例、状态、挂起请求、active-turn chunk 缓冲和 session 流消失。
- `StreamingCursor` 不跨 Server 重启有效；调用方需要先 `session.resume`，再重新订阅并读取已提交历史。

## 4. 传输、安全与错误

### 4.1 JSON-RPC 2.0 over WebSocket

Server 的 wire protocol 使用 [JSON-RPC 2.0](https://www.jsonrpc.org/specification) 单消息格式，WebSocket 只负责双向传输。连接协商的 WebSocket subprotocol 是 `vibest.server.v1`。

传输规则：

- 客户端必须在 upgrade 时提供 `Sec-WebSocket-Protocol: vibest.server.v1`；服务端未协商到该版本时拒绝建立连接。
- 每条完整的 WebSocket text message 包含一个 UTF-8 JSON-RPC 对象。
- v1 不接受 binary message，也不接受 JSON-RPC batch；收到数组时返回 `-32600 Invalid Request`。
- request id 接受字符串或 JavaScript safe integer；Server client 统一生成字符串。id 在单条连接内必须保持唯一，直到对应 response 返回。
- `params` 缺省或为 JSON object；v1 不接受位置参数数组。
- response 可以乱序返回，通过 id 与 request 关联。
- response、error response 和 notification 可以在同一连接中交错。
- v1 只有客户端发起 JSON-RPC request；服务端通过 notification 主动推送订阅消息。
- WebSocket ping/pong 是传输层控制帧，不包装成 JSON-RPC 消息。

```typescript
type JsonPrimitive = string | number | boolean | null;

type JsonObject = {
  [key: string]: JsonValue;
};

type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

type JsonRpcId = string | number;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: JsonObject;
};

type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result: JsonValue;
};

type JsonRpcFailure = {
  jsonrpc: "2.0";
  // 无法从非法消息中识别 id 时使用 null。
  id: JsonRpcId | null;
  error: {
    code: number;
    message: string;
    data?: JsonValue;
  };
};

type JsonRpcNotification = {
  jsonrpc: "2.0";
  method: string;
  params?: JsonObject;
};
```

以上类型只定义公共 envelope。每个 method 的 params/result 仍必须使用 §6 和 §8 的共享 schema 校验，不能因为公共 envelope 接受任意 JsonObject/JsonValue 就跳过方法级校验。

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "session.create",
  "params": {
    "projectId": "0195b4b3-6dc4-7d41-a9ce-3ab5dcb6cc61",
    "harnessAgentId": "claude-code"
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "projectId": "0195b4b3-6dc4-7d41-a9ce-3ab5dcb6cc61",
    "harnessAgentId": "claude-code",
    "sessionId": "session-01"
  }
}
```

Notification 是 JSON-RPC 2.0 中没有 id 的 request。接收方不得为 notification 返回 response。`subscription.event` 和 `subscription.closed` 是 Server 定义的 notification method，不是 JSON-RPC 自带的订阅协议。

#### 订阅扩展

`session.subscribe` 和 `global.subscribe` 是普通 JSON-RPC request。服务端在返回 response 前已经原子附加订阅，因此 response 发出后不会丢失新事件。

```typescript
type SubscriptionId = string;

type OpenSubscriptionOutput = {
  subscriptionId: SubscriptionId;
};

type UnsubscribeInput = {
  subscriptionId: SubscriptionId;
};

type UnsubscribeOutput = {
  closed: boolean;
};
```

- `global.subscribe` 返回 `OpenSubscriptionOutput`；global 流不做事件重放，重连后通过 list 方法恢复集合状态。
- `session.subscribe` 在 `OpenSubscriptionOutput` 之外原子返回 `SessionRuntimeSnapshot`，并只对当前 active turn 的 `UIMessageChunk` 做内存重放，详见 §6.11 和 §7。
- subscriptionId 是不透明字符串，只在创建它的 WebSocket 连接内有效；客户端不能解析或持久化它。

后续业务事件通过一个统一的 `ServerEvent` notification 发送：

```typescript
type SubscriptionEventNotification = {
  jsonrpc: "2.0";
  method: "subscription.event";
  params: {
    subscriptionId: SubscriptionId;
    event: ServerEvent;
  };
};

type SubscriptionClosedReason =
  | "session_closed"
  | "session_deleted"
  | "stream_replaced"
  | "slow_consumer"
  | "server_shutdown"
  | "internal_error";

type SubscriptionClosedParams =
  | {
      subscriptionId: SubscriptionId;
      reason: Exclude<SubscriptionClosedReason, "internal_error">;
    }
  | {
      subscriptionId: SubscriptionId;
      reason: "internal_error";
      error: ServerErrorData;
    };

type SubscriptionClosedNotification = {
  jsonrpc: "2.0";
  method: "subscription.closed";
  params: SubscriptionClosedParams;
};
```

```json
{
  "jsonrpc": "2.0",
  "method": "subscription.event",
  "params": {
    "subscriptionId": "sub-01",
    "event": {
      "type": "session.turn.started",
      "ref": {
        "projectId": "0195b4b3-6dc4-7d41-a9ce-3ab5dcb6cc61",
        "harnessAgentId": "claude-code",
        "sessionId": "session-01"
      },
      "turnId": "turn-01"
    }
  }
}
```

订阅相关 JSON-RPC 消息：

| 方向                         | method                     | params                                   | result/说明              |
| ---------------------------- | -------------------------- | ---------------------------------------- | ------------------------ |
| client → server request      | `session.subscribe`        | `SubscribeSessionInput`                  | `SubscribeSessionOutput` |
| client → server request      | `global.subscribe`         | `SubscribeGlobalInput`                   | `SubscribeGlobalOutput`  |
| client → server request      | `subscription.unsubscribe` | `UnsubscribeInput`                       | `UnsubscribeOutput`      |
| server → client notification | `subscription.event`       | `{ subscriptionId, event: ServerEvent }` | 不返回 response          |
| server → client notification | `subscription.closed`      | `SubscriptionClosedParams`               | 不返回 response          |

客户端主动取消使用普通 JSON-RPC 方法 `subscription.unsubscribe`。调用幂等；subscriptionId 已不存在时返回 `{ closed: false }`。WebSocket 断开时，该连接上的全部 subscriptionId 立即失效。

Server client 把 subscriptionId、session runtime snapshot 和 notification 包装为客户端订阅对象；这些客户端对象不是 wire 类型。

### 4.2 连接鉴权

- 未配置密码时，服务端默认只允许绑定 loopback 地址。
- 配置密码后，WebSocket upgrade 必须携带 `Authorization: Basic ...`。
- 该 header 由 Node.js/Electron Server client 设置；浏览器原生 WebSocket 不能设置任意 Authorization header，因此 v1 不支持浏览器页面直接连接 Server。
- v1 不接受 query token，避免 token 进入 URL、日志和浏览器历史。
- 非本机部署必须由 TLS 终止层提供 `wss://`。

连接鉴权不替代文件系统边界检查。

### 4.3 工作区边界

服务端启动时必须配置一个或多个 `allowedRoots`。

`project.create({ cwd })` 时：

1. cwd 必须存在。
2. 通过 `realpath` 得到规范路径。
3. 规范路径必须位于某个 `allowedRoot` 内。
4. `projects.json` 只保存规范化后的 cwd。

Session API 收到 `projectId` 时：

1. 从 `projects.json` 找到 Project。
2. 对保存的 cwd 再执行存在性和 allowedRoots 校验。
3. Project 不存在返回 `NOT_FOUND`；路径已失效或越界返回 `FORBIDDEN`。

fs/git/pty 收到直接 cwd 时，独立执行同样的 realpath 和 allowedRoots 校验，不查询 Project。

对 `fs` 的相对路径：

1. 相对本次请求显式传入并已规范化的 cwd 解析。
2. 对目标执行 `realpath`。
3. 目标必须仍位于该 cwd 内。
4. 符号链接不能绕过上述检查。

违反边界时不能把宿主机真实敏感路径写入错误消息。

### 4.4 错误契约

JSON-RPC 协议错误使用标准数字错误码：

|     code | 含义             | 使用场景                                       |
| -------: | ---------------- | ---------------------------------------------- |
| `-32700` | Parse error      | WebSocket text message 不是合法 JSON           |
| `-32600` | Invalid Request  | envelope 非法、batch 或不支持的 id/params 形式 |
| `-32601` | Method not found | method 未注册                                  |
| `-32602` | Invalid params   | params 不符合该 method 的共享 schema           |
| `-32603` | Internal error   | 未分类服务端异常                               |

通过 envelope 和 method schema 校验后发生的 Server 业务错误统一使用 JSON-RPC code `-32000`；此时 `error.data` 必须符合 `ServerErrorData`，稳定语义放在 `error.data.code`：

```typescript
type ServerErrorCode =
  | "INVALID_ARGUMENT"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "SESSION_CRASHED"
  | "CONFLICT"
  | "UNSUPPORTED"
  | "RATE_LIMITED"
  | "INTERNAL";

type ServerErrorData = {
  code: ServerErrorCode;
  details?: JsonObject;
  retryAfterMs?: number;
};
```

```json
{
  "jsonrpc": "2.0",
  "id": "req-42",
  "error": {
    "code": -32000,
    "message": "Project not found",
    "data": {
      "code": "NOT_FOUND",
      "details": {
        "resource": "project"
      }
    }
  }
}
```

通用规则：

- JSON 结构、JSON-RPC envelope 或 method params schema 错误使用对应标准错误码，不使用业务错误码。
- 参数形状合法但 Provider 与 Agent 不兼容：`-32000` + `INVALID_ARGUMENT`。
- Session 元数据文件、Provider、Project 不存在：`-32000` + `NOT_FOUND`。
- 活跃实例不存在：`-32000` + `SESSION_NOT_ACTIVE`。
- 会话处于 crash 终态：`-32000` + `SESSION_CRASHED`。
- 当前状态不允许该操作：`-32000` + `CONFLICT`。
- Agent 不支持某项能力：`-32000` + `UNSUPPORTED`。
- 未分类内部异常：`-32603`，`data.code` 可以是 `INTERNAL`；服务端记录原始错误，但 response 不泄露堆栈、凭证或宿主机敏感路径。
- 客户端根据 `error.data.code` 分支，不解析 message。

WebSocket upgrade 鉴权失败直接返回 HTTP 401，连接不会建立，因此 v1 不定义 `UNAUTHENTICATED` JSON-RPC 业务错误。

## 5. API 总览

### 5.1 session 方法

v1 有 16 个 session 方法：

| 方法                          | 类别     | 说明                                                 |
| ----------------------------- | -------- | ---------------------------------------------------- |
| `session.create`              | 生命周期 | 创建新会话并拉起实例                                 |
| `session.resume`              | 生命周期 | 从 Session 元数据文件和原生历史恢复实例              |
| `session.close`               | 生命周期 | 关闭实例和 session 流，保留历史与 Session 元数据文件 |
| `session.list`                | 历史     | 按 projectId 列出 Server 管理的会话                  |
| `session.rename`              | 历史     | 修改 Agent 原生标题                                  |
| `session.delete`              | 历史     | 删除原生历史、Session 元数据文件和残留流             |
| `session.prompt`              | 活跃实例 | 发送文本；turn 进行中时执行 steer                    |
| `session.interrupt`           | 活跃实例 | 中断当前 turn                                        |
| `session.setModel`            | 活跃实例 | 设置后续 turn 使用的模型                             |
| `session.getConfigOption`     | 活跃实例 | 读取当前配置目录                                     |
| `session.setConfigOption`     | 活跃实例 | 修改一个配置项                                       |
| `session.respondAgentRequest` | 活跃实例 | 回应审批、计划或提问                                 |
| `session.getStatus`           | 活跃实例 | 读取当前状态机                                       |
| `session.getMessages`         | 历史     | 读取已提交历史并归一化为 `UIMessage[]`               |
| `session.getSnapshot`         | 活跃实例 | 查询当前 Session 运行时状态                          |
| `session.subscribe`           | 事件     | 原子获取运行时快照并订阅单个会话流                   |

`global.subscribe` 是独立的 global 流，不计入上述 16 个方法。`subscription.unsubscribe` 是通用的订阅控制方法。`subscription.event` 和 `subscription.closed` 是服务端 JSON-RPC notification，不是可调用方法。

### 5.2 调用约束

- `create` 和 `resume` 自己负责拉起实例。
- `prompt`、`setModel`、配置、请求响应、状态、运行时快照和 session 订阅要求实例存在。
- `list`、`rename`、`delete`、`getMessages` 不要求实例活跃。
- `close` 对已存在 Session 元数据文件但当前未活跃的会话是幂等 no-op。
- `delete` 如果会话仍活跃，先关闭实例，再删除历史和 Session 元数据文件。
- `subscribe` 只对活跃或 crash 终态的会话流有效；服务端重启后需要先 `resume`。

## 6. session 对外契约

本章在 §4.1 的 JSON-RPC、JSON value 和 subscription 公共类型之上，完整定义 session 的 method params/result 与事件类型，是服务端、Server client 和 React 状态层共享 contract 的来源。客户端语法糖和 Agent 专属扩展会明确标注，不能与 wire 类型混用。

| 方法                          | 输入                       | 输出                        | 活跃实例要求    |
| ----------------------------- | -------------------------- | --------------------------- | --------------- |
| `session.create`              | `CreateSessionInput`       | `CreateSessionOutput`       | 自己创建        |
| `session.resume`              | `ResumeSessionInput`       | `ResumeSessionOutput`       | 自己恢复        |
| `session.close`               | `CloseSessionInput`        | `CloseSessionOutput`        | 否，幂等        |
| `session.list`                | `ListSessionsInput`        | `ListSessionsOutput`        | 否              |
| `session.rename`              | `RenameSessionInput`       | `RenameSessionOutput`       | 否              |
| `session.delete`              | `DeleteSessionInput`       | `DeleteSessionOutput`       | 否              |
| `session.prompt`              | `PromptInput`              | `PromptOutput`              | 是              |
| `session.interrupt`           | `InterruptInput`           | `InterruptOutput`           | 是              |
| `session.setModel`            | `SetModelInput`            | `SetModelOutput`            | 是，且必须 idle |
| `session.getConfigOption`     | `GetConfigOptionInput`     | `GetConfigOptionOutput`     | 是              |
| `session.setConfigOption`     | `SetConfigOptionInput`     | `SetConfigOptionOutput`     | 是，且必须 idle |
| `session.respondAgentRequest` | `RespondAgentRequestInput` | `RespondAgentRequestOutput` | 是              |
| `session.getStatus`           | `GetStatusInput`           | `GetStatusOutput`           | 是或 crash 终态 |
| `session.getMessages`         | `GetMessagesInput`         | `GetMessagesOutput`         | 否              |
| `session.getSnapshot`         | `GetSnapshotInput`         | `GetSnapshotOutput`         | 是或 crash 终态 |
| `session.subscribe`           | `SubscribeSessionInput`    | `SubscribeSessionOutput`    | 是或 crash 终态 |

### 6.1 共享类型

```typescript
type ProjectId = string; // UUID, wire 上按 string 传输并做 UUID 校验

type HarnessAgentId = "claude-code" | "codex";

type SessionRef = {
  projectId: ProjectId;
  harnessAgentId: HarnessAgentId;
  sessionId: string;
};

type StreamingCursor = {
  // 只在同一 Server runtime 的当前 active turn 内有效。
  turnId: string;

  // Renderer 已成功归并的最后一个 UIMessageChunk；0 表示尚未处理 chunk。
  chunkSeq: number;
};

type SessionConfig = {
  // providerId 与 modelId 必须成对出现。
  providerId?: string;
  modelId?: string;

  // 用户显式设置过的运行时配置项；键是配置目录中的 configId（§6.6）。
  options?: Record<string, string | boolean>;
};
```

共享不变量：

- `projectId` 必须能在 `$VIBEST_HOME/storage/projects.json` 中找到唯一 Project。
- `sessionId` 是 Server 生成的项目内不透明 ID，不是 Agent 原生 ID。
- `SessionConfig` 的 providerId 与 modelId 必须成对出现；只出现一个返回 `INVALID_ARGUMENT`。
- providerId/modelId 缺省表示没有显式模型路由，使用 Agent 原生默认值。
- `SessionConfig.options` 只记录用户通过 `setConfigOption` 显式设置过的项；`SessionConfigOption` 是 Agent 提供的配置目录条目，configId 键和合法值以目录为准（§6.6）。
- `StreamingCursor` 只能与 Renderer 内存中的同一 turn reducer 状态一起使用，不能脱离该状态单独持久化。
- 所有时间字段使用 ISO 8601 UTC 字符串。
- 所有 wire payload 必须可 JSON 序列化；`undefined` 只表示字段缺省。

### 6.2 创建与恢复

```typescript
type SessionMcpServer =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }
  | {
      name: string;
      transport: "remote";
      url: string;
      headers?: Record<string, string>;
    };

type ClaudeCodeNativeOptions = {
  // 裸字符串替换 base prompt；preset 形状在默认 prompt 后追加。
  systemPrompt?:
    | string
    | {
        type: "preset";
        preset: "claude_code";
        append?: string;
      };

  // 低层 escape hatch。常规 UI 应优先使用配置目录。
  permissionMode?: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  agent?: string;

  agents?: Record<string, JsonValue>;
  allowedTools?: string[];
  disallowedTools?: string[];
  additionalDirectories?: string[];
  mcpServers?: SessionMcpServer[];
};

type CodexNativeOptions = {
  baseInstructions?: string;
  developerInstructions?: string;

  // 低层 escape hatch。常规 UI 应优先使用配置目录。
  approvalPolicy?: JsonValue;
  sandboxPolicy?: JsonValue;
  effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
};

type CreateSessionInput = {
  projectId: ProjectId;
  config?: SessionConfig;
} & (
  | {
      harnessAgentId: "claude-code";
      nativeOptions?: ClaudeCodeNativeOptions;
    }
  | {
      harnessAgentId: "codex";
      nativeOptions?: CodexNativeOptions;
    }
);

type CreateSessionOutput = SessionRef;
```

create 期的 `config` 只接受 providerId/modelId，携带 `options` 返回 `INVALID_ARGUMENT`：创建时沿用 Agent 原生默认值（或 nativeOptions），运行时配置在创建成功后按以下顺序设置：

```text
session.create
  -> session.setConfigOption（零到多次）
  -> session.prompt
```

常规调用只通过 `setConfigOption` 修改 mode、effort 等运行时配置。`nativeOptions` 保留原生 escape hatch：system prompt、工具白名单等只能在创建期表达；`permissionMode`、`approvalPolicy`、`sandboxPolicy`、`effort` 等重叠字段只供底层调用方使用。若创建后再次调用 `setConfigOption`，后调用的配置值生效。

```typescript
type ResumeSessionInput = {
  projectId: ProjectId;
  sessionId: string;
  config?: SessionConfig;
} & (
  | {
      harnessAgentId: "claude-code";
      nativeOptions?: ClaudeCodeNativeOptions;
    }
  | {
      harnessAgentId: "codex";
      nativeOptions?: CodexNativeOptions;
    }
);

type ResumeSessionOutput = SessionRef;
```

创建与恢复都会先通过 `projectId` 查询 Project，再把 `Project.cwd` 作为 Agent 工作目录。调用方不能覆盖该 cwd。

恢复规则：

- 实例已活跃时直接返回同一个 `SessionRef`。
- resume 入参的 `config` 同样只接受 providerId/modelId，携带 `options` 返回 `INVALID_ARGUMENT`；显式传入时覆盖元数据中的 providerId/modelId，并用于本次恢复。
- 未传时优先使用 Session 元数据文件中的 providerId/modelId；元数据没有时使用 Agent 原生默认值。
- 实例拉起后按元数据 `config.options` 逐项重放，与 `setConfigOption` 走同一条 adapter 路径；当前配置目录中已失效的项跳过，不阻塞 resume。
- `nativeOptions` 只影响本次恢复，不写入 Session 元数据文件。
- create/resume 都只返回 `SessionRef`；SessionConfig、运行时配置和状态通过 `getSnapshot`、`subscribe.snapshot` 或相应查询方法读取。

### 6.3 关闭、列表、重命名和删除

```typescript
type CloseSessionInput = SessionRef;
type CloseSessionOutput = void;

type ListSessionsInput = {
  projectId: ProjectId;
};

type SessionSummary = {
  projectId: ProjectId;
  harnessAgentId: HarnessAgentId;
  sessionId: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
  historyAvailable: boolean;
  config?: SessionConfig;
  status?: SessionStatus;
};

type ListSessionsOutput = {
  sessions: SessionSummary[];
};

type RenameSessionInput = SessionRef & {
  title: string;
};

type RenameSessionOutput = void;

type DeleteSessionInput = SessionRef;
type DeleteSessionOutput = void;
```

`session.list` 以 `projectId` 和 Session 元数据文件为会话索引：

1. 从 `projects.json` 读取 Project；不存在则返回 `NOT_FOUND`。
2. 读取 `sessions/<projectId>/*.json`。
3. 使用 `Project.cwd`，按 `harnessAgentId` 分组查询 Agent 原生列表。
4. 用 `harnessSessionId` 合并标题和更新时间。
5. 补充服务端内存中的活跃或 crash 状态。

没有 Session 元数据文件的原生会话不出现在 v1 列表中。Session 元数据文件存在但原生历史缺失时仍返回摘要，`historyAvailable` 为 `false`，方便用户删除悬空记录。

`rename` 在 `historyAvailable=false` 时返回 `NOT_FOUND`。`delete` 会容忍原生历史已经不存在，但 Session 元数据文件本身不存在时返回 `NOT_FOUND`。

### 6.4 消息与 turn

wire 统一接收一条用户消息的 `parts`。文本是 v1 必须支持的分支；file 分支保留完整协议形状，在对应 Agent 能力落地前返回 `UNSUPPORTED`。

```typescript
type TextPromptPart = {
  type: "text";
  text: string;
};

type FilePromptPart = {
  type: "file";
  mediaType: string;
  url: string;
  filename?: string;
};

type PromptPart = TextPromptPart | FilePromptPart;

type PromptInput = SessionRef & {
  parts: PromptPart[];
};

type PromptOutput = {
  turnId: string;
};
```

Server client 的调用输入不进入 wire：

```typescript
type PromptSugar =
  | {
      text: string;
      files?: FilePromptPart[];
    }
  | {
      files: FilePromptPart[];
    }
  | {
      parts: PromptPart[];
    };

declare function prompt(ref: SessionRef, input: PromptSugar): Promise<PromptOutput>;
```

归一化结果始终是：

```typescript
const wireInput: PromptInput = {
  ...ref,
  parts: [{ type: "text", text: "修复登录问题" }],
};
```

输入约束：

- `parts` 至少包含一个元素。
- text 不能是空字符串；是否 trim 由客户端决定，服务端不改写正文。
- v1 收到 file part 时返回 `UNSUPPORTED`，不能静默丢附件。
- 后续实现 file 时，`url` 允许的 scheme、大小上限和远程下载策略必须由能力声明约束。

turn 语义：

- 空闲时调用：创建新 turn，返回新 `turnId`。
- 每个 Session 同时最多有一个 active turn。
- turn 进行中调用：执行 steer，返回当前活跃 `turnId`，不创建第二个 turn。
- 一个 Agent Loop/turn 在公共层归一化为一个 assistant `UIMessage`；text、reasoning、tool call、tool result 和多个 step 都进入该消息的 `parts`。
- ACK 表示 Agent 已受理输入，不表示 turn 完成。
- 结果、错误和结束原因全部通过 session 流到达。

```typescript
type InterruptInput = SessionRef;
type InterruptOutput = void;
```

空闲时调用 `interrupt` 是幂等 no-op。成功中断后，流中出现：

```typescript
{
  type: "session.turn.ended";
  ref: SessionRef;
  turnId: string;
  outcome: "canceled";
}
```

### 6.5 模型配置

```typescript
type SetModelInput = SessionRef & {
  config: SessionConfig;
};
type SetModelOutput = void;
```

规则：

- 入参 `config` 必须包含成对 providerId/modelId，携带 `options` 返回 `INVALID_ARGUMENT`；options 只能走 `setConfigOption`。
- 只允许在 `idle` 状态调用；turn 进行中返回 `CONFLICT`。
- Provider 协议必须与 Agent 的 `supportedProtocols` 兼容。
- Claude Code 在 idle 状态即时切换。
- Codex 在下一个 turn 生效。
- Codex 活跃线程不能切换 Provider；跨 Provider 返回 `UNSUPPORTED`，调用方需要 `close` 后用新选择 `resume`。
- 成功后同步更新 Session 元数据文件 `config` 中的 providerId/modelId，并广播 `session.model.updated`；事件中的 config 只含成对 providerId/modelId，不带 options。
- 如果模型变化导致配置选项变化，再广播完整的 `session.config.updated`。

### 6.6 配置目录

静态目录用于创建会话前渲染配置 UI：

```typescript
type ConfigCategory = "mode" | "model_config" | "thought_level";

type ConfigSchemaEntry = {
  configId: string;
  label: string;
  description?: string;
  category?: ConfigCategory;
} & (
  | {
      kind: "enum";
      defaultValue: string;
      values: { value: string; label: string; description?: string }[];
    }
  | {
      kind: "boolean";
      defaultValue: boolean;
    }
  | {
      kind: "dynamic-select";
    }
);
```

运行时目录包含真实当前值：

```typescript
type SessionConfigOption = {
  configId: string;
  name: string;
  description?: string;
  category?: ConfigCategory;
} & (
  | {
      type: "select";
      currentValue: string;
      options: { value: string; name: string; description?: string }[];
    }
  | {
      type: "boolean";
      currentValue: boolean;
    }
);

type GetConfigOptionInput = SessionRef;
type GetConfigOptionOutput = {
  configOptions: SessionConfigOption[];
};

type SetConfigOptionInput = SessionRef & {
  configId: string;
  value: string | boolean;
};

type SetConfigOptionOutput = void;
```

规则：

- v1 只允许在 `idle` 状态修改配置。
- 未知 `configId`、错误值类型或越界枚举返回 `INVALID_ARGUMENT`。
- `setConfigOption` 只返回 ACK。
- 成功后同步写入 Session 元数据文件的 `config.options[configId]`（§3.1）；只持久化用户显式设置，Agent 侧自行变化的配置不回写。
- 成功后广播 `session.config.updated`，payload 是完整目录；客户端整体替换，不做增量合并。
- 静态 schema 与运行时目录都由各 Agent 实现提供可直接展示的中文 label/name。
- model 不进入配置目录；模型列表来自 `provider.models`，修改走 `setModel`。

### 6.7 状态

```typescript
type SessionStatus = {
  phase: "idle" | "running" | "requires_action" | "crashed";
  activeTurnId?: string;
};

type GetStatusInput = SessionRef;
type GetStatusOutput = SessionStatus;
```

状态迁移：

```text
create/resume 完成                 -> idle
session.turn.started              -> running
session.request.asked             -> requires_action
session.request.replied           -> running
session.turn.ended                -> idle
Agent 事件流异常                  -> crashed
```

没有 `closed` 状态：close 后活跃实例和流都被销毁，`session.list` 中的 `status` 缺省。

没有 `initializing` 状态：create/resume 在实例、Session 元数据文件、运行时状态和流都就绪后才返回。

### 6.8 审批、计划和提问

```typescript
type AgentRequestType = "tool" | "plan" | "question";

type AgentRequestAction = {
  // 稳定 wire ID，响应时作为 selectedActionId 原样传回。
  id: string;
  label: string;
  behavior: "allow" | "deny";
  scope?: "once" | "session";
  intent?: "implement" | "dismiss" | "implement-resume";
};

type AgentRequestQuestion = {
  id: string;
  question: string;
  header?: string;
  kind?: "choice" | "freeText" | "secret";
  options?: {
    label: string;
    description?: string;
    preview?: string;
  }[];
  multiSelect?: boolean;
  allowOther?: boolean;
};

type AgentRequestCommon =
  | {
      type: "tool";
      id: string;
      toolCallId?: string;
      toolName: string;
      input: JsonValue;
      actions: AgentRequestAction[];
      title?: string;
      description?: string;
    }
  | {
      type: "plan";
      id: string;
      plan: string;
      allowedPrompts?: string[];
      actions: AgentRequestAction[];
    }
  | {
      type: "question";
      id: string;
      questions: AgentRequestQuestion[];
    };

type ClaudeCodeRequestNative = {
  toolUseID?: string;
  suggestions?: JsonValue[];
};

type CodexRequestNative =
  | {
      source: "commandExecution";
      reason?: string;
      proposedExecpolicyAmendment?: JsonValue;
      proposedNetworkPolicyAmendments?: JsonValue[];
    }
  | {
      source: "fileChange";
      reason?: string;
      grantRoot?: string;
    }
  | {
      source: "permissions";
      profile: JsonValue;
    }
  | {
      source: "requestUserInput";
    };

type AgentRequest =
  | ({
      harnessAgentId: "claude-code";
      native?: ClaudeCodeRequestNative;
    } & AgentRequestCommon)
  | ({
      harnessAgentId: "codex";
      native?: CodexRequestNative;
    } & AgentRequestCommon);

type AgentResponseAnswer = {
  questionId: string;
  values: string[];
  other?: string;
};

type AgentResponseCommon =
  | {
      type: "tool";
      selectedActionId?: string;
      behavior: "allow" | "deny";
      message?: string;
      interrupt?: boolean;
    }
  | {
      type: "plan";
      selectedActionId?: string;
      behavior: "allow" | "deny";
      message?: string;
      interrupt?: boolean;
    }
  | {
      type: "question";
      answers: AgentResponseAnswer[];
    }
  | {
      type: "cancelled";
    };

type ClaudeCodeResponseNative = {
  updatedInput?: Record<string, JsonValue>;
  updatedPermissions?: JsonValue[];
};

type CodexResponseNative =
  | {
      source: "commandExecution";
      decision: JsonValue;
    }
  | {
      source: "fileChange";
      decision: JsonValue;
    }
  | {
      source: "permissions";
      permissions: JsonValue;
      scope: JsonValue;
      strictAutoReview?: boolean;
    };

type AgentRequestResponse =
  | ({
      harnessAgentId: "claude-code";
      native?: ClaudeCodeResponseNative;
    } & AgentResponseCommon)
  | ({
      harnessAgentId: "codex";
      native?: CodexResponseNative;
    } & AgentResponseCommon);

type RespondAgentRequestInput = SessionRef & {
  requestId: string;
  response: AgentRequestResponse;
};

type RespondAgentRequestOutput = void;
```

不变量：

- 每个请求都能用 `{ type: 'cancelled' }` 安全结束。
- 服务端按 `requestId` 保存原生 resolver 和原请求类型。
- `response.harnessAgentId` 必须与外层 `SessionRef.harnessAgentId` 和原请求一致，否则返回 `INVALID_ARGUMENT`。
- tool/plan 响应若同时携带 `selectedActionId` 与 `behavior`，两者必须对应同一个 action。
- 多客户端同时响应时，先到先得；后续响应是幂等 no-op。
- 成功响应后广播 `session.request.replied`，让其他客户端撤下卡片。
- close、interrupt 或 crash 导致请求无法继续时，服务端调用对应 Agent 的拒绝原语并广播 `session.request.rejected`。
- `native` 只承载公共层无法表达的 Agent 原生字段；不了解它的客户端可以忽略。

### 6.9 历史消息

历史与实时消息使用不同 wire 形状：`session.getMessages` 返回已经提交的完整 `UIMessage[]`，`session.message.chunk` 实时发送 `UIMessageChunk`。`UIMessageChunk -> UIMessage` 的归并属于 Renderer，不在 Server 服务端执行。

```typescript
type ProviderMetadata = Record<string, Record<string, JsonValue>>;

type ClaudeCodeMessageMetadata = {
  projectId: ProjectId;
  harnessAgentId: "claude-code";
  sessionId: string;
  parentToolUseId: string | null;
  source?: {
    platform: string;
  };
};

type CodexMessageMetadata = {
  projectId: ProjectId;
  harnessAgentId: "codex";
  sessionId: string;
};

type MessageMetadata = ClaudeCodeMessageMetadata | CodexMessageMetadata;

type MessageMetadataPatch =
  | ({
      harnessAgentId: "claude-code";
    } & Partial<Omit<ClaudeCodeMessageMetadata, "harnessAgentId">>)
  | ({
      harnessAgentId: "codex";
    } & Partial<Omit<CodexMessageMetadata, "harnessAgentId">>);

type ToolMessageState =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

type ToolApprovalState = {
  id: string;
  approved?: boolean;
  reason?: string;
  isAutomatic?: boolean;
  signature?: string;
};

type UIMessagePart =
  | {
      type: "text";
      text: string;
      state?: "streaming" | "done";
      providerMetadata?: ProviderMetadata;
    }
  | {
      type: "reasoning";
      text: string;
      state?: "streaming" | "done";
      providerMetadata?: ProviderMetadata;
    }
  | {
      type: "file";
      mediaType: string;
      url: string;
      filename?: string;
    }
  | {
      type: "source-url";
      sourceId: string;
      url: string;
      title?: string;
    }
  | {
      type: "source-document";
      sourceId: string;
      mediaType: string;
      title: string;
      filename?: string;
    }
  | {
      type: `tool-${string}`;
      toolCallId: string;
      state: ToolMessageState;
      input: JsonValue;
      output?: JsonValue;
      errorText?: string;
      approval?: ToolApprovalState;
      providerExecuted?: boolean;
      providerMetadata?: ProviderMetadata;
      title?: string;
      toolMetadata?: JsonObject;
    }
  | {
      type: "dynamic-tool";
      toolName: string;
      toolCallId: string;
      state: ToolMessageState;
      input: JsonValue;
      output?: JsonValue;
      errorText?: string;
      approval?: ToolApprovalState;
      providerExecuted?: boolean;
      providerMetadata?: ProviderMetadata;
      title?: string;
      toolMetadata?: JsonObject;
    }
  | {
      type: `data-${string}`;
      id?: string;
      data: JsonValue;
    }
  | {
      type: "step-start";
    };

type UIMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  metadata?: MessageMetadata;
  parts: UIMessagePart[];
};

type GetMessagesInput = SessionRef;

type GetMessagesOutput = {
  messages: UIMessage[];
};
```

历史契约：

- `getMessages` 只返回已经提交到 Agent 原生历史的消息，永远排除当前 active turn 的临时流式消息。
- 一个 Agent Loop 最终只产生一个 assistant `UIMessage`；工具循环和多个模型 step 归并到同一 `parts` 数组。
- 完整 chunk 流在 Renderer 中归并出的 `UIMessage.id`，必须与同一 Agent Loop 最终由 `getMessages` 返回的 assistant `UIMessage.id` 完全一致。
- 实时路径和历史路径的 wire shape 不同，但 Adapter 必须保证两条路径归一化后的 message ID、part 顺序和语义一致。
- Agent 原生专属消息可以放进 `data-*`，但 v1 不承诺任何具体 Agent 专属 data 名称；客户端必须忽略不认识的 `data-*`。

### 6.10 运行时快照

```typescript
type ActiveTurnSnapshot = {
  turnId: string;

  // 第一个 start chunk 到达前为 null。
  messageId: string | null;

  // 当前 turn 已产生的最后一个 UIMessageChunk；尚无 chunk 时为 0。
  headChunkSeq: number;
};

type SessionRuntimeSnapshot = {
  ref: SessionRef;
  activeTurn: ActiveTurnSnapshot | null;
  pendingRequests: AgentRequest[];
  status: SessionStatus;
  config?: SessionConfig;
  configOptions: SessionConfigOption[];
};

type GetSnapshotInput = SessionRef;
type GetSnapshotOutput = SessionRuntimeSnapshot;
```

运行时快照只描述服务端内存状态，不包含历史 `UIMessage`，也不包含 active turn 的 `UIMessageChunk`。历史由 `getMessages` 查询，当前 turn 的 chunk 由 `session.subscribe` replay。独立调用 `getSnapshot` 只得到调用瞬间的状态；用于建立无丢失事件边界时，以 `session.subscribe` 原子返回的 snapshot 为准。

### 6.11 订阅契约

```typescript
type SubscribeSessionInput = SessionRef & {
  streamingCursor?: StreamingCursor;
};

type SubscribeSessionOutput = OpenSubscriptionOutput & {
  snapshot: SessionRuntimeSnapshot;
};

type SubscribeGlobalInput = Record<string, never>;
type SubscribeGlobalOutput = OpenSubscriptionOutput;
```

`session.subscribe` 在同一个 SessionRuntime 串行边界内注册订阅者、捕获运行时快照和 `headChunkSeq`，再返回 response。`global.subscribe` 只返回 subscriptionId；global 集合状态通过 list 方法恢复。

Server client 提供以下本地语法糖；`AsyncIterable` 不属于 wire：

```typescript
type ServerClientSessionSubscription = {
  snapshot: SessionRuntimeSnapshot;
  events: AsyncIterable<ServerEvent>;
  unsubscribe(): Promise<void>;
};

type ServerClientGlobalSubscription = {
  events: AsyncIterable<ServerEvent>;
  unsubscribe(): Promise<void>;
};

interface ServerClientSubscriptions {
  session: {
    subscribe(
      ref: SessionRef,
      input?: { streamingCursor?: StreamingCursor },
    ): Promise<ServerClientSessionSubscription>;
  };
  global: {
    subscribe(): Promise<ServerClientGlobalSubscription>;
  };
}
```

- 客户端主动结束时调用 `unsubscribe()`。
- 服务端发送 `subscription.closed` 时，events 迭代器以包含 reason 的订阅关闭错误结束。
- WebSocket 断开时 events 迭代器以连接错误结束。
- `streamingCursor` 的有效条件与重订时传不传的取舍见 §7.2 与 §7.6。

### 6.12 事件全集

所有订阅统一传输一个 `ServerEvent` 联合。事件名是以 `session.` 开头的点分层级标识，不增加 `agent.` 前缀，也不要求固定段数：Session 生命周期可以使用 `session.created`，子实体事件可以使用 `session.turn.started`。每个完整 type 必须在 Server 协议内全局唯一，并表示已经发生的事实而不是命令。

```typescript
type ServerEvent = {
  ref: SessionRef;
} & (
  | {
      type: "session.created";
    }
  | {
      type: "session.deleted";
    }
  | {
      type: "session.renamed";
      title: string;
    }
  | {
      type: "session.message.chunk";
      turnId: string;

      // 只在当前 turn 内单调递增，从 1 开始。
      chunkSeq: number;
      chunk: UIMessageChunk;
    }
  | {
      type: "session.config.updated";
      configOptions: SessionConfigOption[];
    }
  | {
      type: "session.model.updated";
      config: SessionConfig;
    }
  | {
      type: "session.turn.started";
      turnId: string;
    }
  | {
      type: "session.turn.ended";
      turnId: string;
      outcome: "completed" | "failed" | "canceled";
      usage?: TokenUsage;
      error?: TurnError;
    }
  | {
      type: "session.request.asked";
      request: AgentRequest;
    }
  | {
      type: "session.request.replied";
      requestId: string;
    }
  | {
      type: "session.request.rejected";
      requestId: string;
      reason: string;
    }
  | {
      type: "session.crashed";
      reason: string;
      recoverable: boolean;
    }
);
```

订阅范围决定允许出现的事件，不需要在每个事件中再携带 global/session 标记：

- `global.subscribe` 只发送 `session.created`、`session.deleted`、`session.renamed`。
- `session.subscribe(ref)` 只发送其 ref 完全一致的其余事件。
- 普通事件不重放，也不携带通用 seq；订阅前发生的普通状态变化由 `SessionRuntimeSnapshot` 或 list 方法恢复。
- 只有 `session.message.chunk` 可以重放。`chunkSeq` 对当前 turn 的所有 `UIMessageChunk` 建立全序；`turnId` 变化后重新从 1 开始。

```typescript
type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
};

type TurnErrorCategory =
  | "auth_expired"
  | "rate_limited"
  | "context_overflow"
  | "model_unavailable"
  | "network"
  | "cancelled"
  | "unknown";

type TurnError = {
  message: string;
  category: TurnErrorCategory;
  retryAfterMs?: number;
};
```

```typescript
type FinishReason =
  "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other" | "unknown";

type UIMessageChunk =
  | {
      type: "start";
      // 每个 turn 的第一个 chunk 必须提供稳定 messageId。
      messageId: string;
      messageMetadata?: MessageMetadata;
    }
  | {
      type: "message-metadata";
      messageMetadata: MessageMetadataPatch;
    }
  | { type: "text-start"; id: string }
  | {
      type: "text-delta";
      id: string;
      delta: string;
      providerMetadata?: ProviderMetadata;
    }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | {
      type: "reasoning-delta";
      id: string;
      delta: string;
      providerMetadata?: ProviderMetadata;
    }
  | { type: "reasoning-end"; id: string }
  | {
      type: "tool-input-start";
      toolCallId: string;
      toolName: string;
      dynamic?: boolean;
    }
  | {
      type: "tool-input-delta";
      toolCallId: string;
      inputTextDelta: string;
    }
  | {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: JsonValue;
      providerExecuted?: boolean;
      dynamic?: boolean;
      providerMetadata?: ProviderMetadata;
    }
  | {
      type: "tool-input-error";
      toolCallId: string;
      toolName: string;
      input: JsonValue;
      errorText: string;
      dynamic?: boolean;
    }
  | {
      type: "tool-approval-request";
      approvalId: string;
      toolCallId: string;
    }
  | {
      type: "tool-approval-response";
      approvalId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      type: "tool-output-available";
      toolCallId: string;
      output: JsonValue;
      providerExecuted?: boolean;
      dynamic?: boolean;
    }
  | {
      type: "tool-output-error";
      toolCallId: string;
      errorText: string;
      dynamic?: boolean;
    }
  | {
      type: "tool-output-denied";
      toolCallId: string;
    }
  | {
      type: "file";
      mediaType: string;
      url: string;
    }
  | {
      type: "source-url";
      sourceId: string;
      url: string;
      title?: string;
    }
  | {
      type: "source-document";
      sourceId: string;
      mediaType: string;
      title: string;
      filename?: string;
    }
  | {
      type: `data-${string}`;
      id?: string;
      data: JsonValue;
    }
  | { type: "start-step" }
  | { type: "finish-step" }
  | { type: "error"; errorText: string }
  | { type: "abort" }
  | {
      type: "finish";
      finishReason?: FinishReason;
    };
```

v1 的消息 chunk 是跨 Agent 公共类型，不宣称根据 `harnessAgentId` 自动收窄成某个 Agent 的原生联合。

Chunk 不变量：

- 一个 active turn 的第一个 chunk 必须是携带 `messageId` 的 `start`，其 `chunkSeq` 为 1。
- 后续 chunkSeq 必须连续递增；Renderer 对重复 chunk（`chunkSeq <= lastAppliedChunkSeq`）幂等忽略，对缺口（`chunkSeq > lastAppliedChunkSeq + 1`）终止当前订阅并按最后成功 cursor 重订。
- `start.messageId` 必须等于该 turn 最终历史 assistant `UIMessage.id`。
- 同一订阅内 replay chunk 必须先于该边界之后的 live 事件，不能与 live 交错。

### 6.13 方法级状态与错误

下表“主要错误”均指 `-32000` response 中的 `error.data.code`；JSON-RPC envelope、method 和 params schema 错误仍使用 §4.4 的标准数字错误码。

| 方法                  | 允许状态                                             | 主要错误                                                            |
| --------------------- | ---------------------------------------------------- | ------------------------------------------------------------------- |
| `create`              | projectId 存在，无已有会话要求                       | `NOT_FOUND`、`INVALID_ARGUMENT`、`FORBIDDEN`、`UNSUPPORTED`         |
| `resume`              | Project 和 Session 元数据文件存在；active 时幂等返回 | `NOT_FOUND`、`FORBIDDEN`、`INVALID_ARGUMENT`                        |
| `close`               | Session 元数据文件存在；会话可活跃或未活跃           | `NOT_FOUND`                                                         |
| `list`                | projectId 存在                                       | `NOT_FOUND`、`FORBIDDEN`                                            |
| `rename`              | 历史存在                                             | `NOT_FOUND`                                                         |
| `delete`              | Session 元数据文件存在                               | `NOT_FOUND`、`CONFLICT`                                             |
| `prompt`              | `idle` 或 `running`                                  | `SESSION_NOT_ACTIVE`、`SESSION_CRASHED`、`UNSUPPORTED`              |
| `interrupt`           | `idle`、`running`、`requires_action`                 | `SESSION_NOT_ACTIVE`、`SESSION_CRASHED`                             |
| `setModel`            | `idle`                                               | `SESSION_NOT_ACTIVE`、`CONFLICT`、`INVALID_ARGUMENT`、`UNSUPPORTED` |
| `getConfigOption`     | active 或 crash 终态                                 | `SESSION_NOT_ACTIVE`                                                |
| `setConfigOption`     | `idle`                                               | `SESSION_NOT_ACTIVE`、`CONFLICT`、`INVALID_ARGUMENT`                |
| `respondAgentRequest` | `requires_action`                                    | `SESSION_NOT_ACTIVE`、`INVALID_ARGUMENT`；已响应时 no-op            |
| `getStatus`           | active 或 crash 终态                                 | `SESSION_NOT_ACTIVE`                                                |
| `getMessages`         | Session 元数据文件与原生历史可定位                   | `NOT_FOUND`                                                         |
| `getSnapshot`         | active 或 crash 终态                                 | `SESSION_NOT_ACTIVE`                                                |
| `subscribe`           | active 或 crash 终态                                 | `SESSION_NOT_ACTIVE`、`INVALID_ARGUMENT`                            |

session contract 对外导出的类型集合：

```typescript
type SessionContractExports = {
  ref: SessionRef;
  config: SessionConfig;
  streamingCursor: StreamingCursor;
  runtimeSnapshot: SessionRuntimeSnapshot;
  event: ServerEvent;
  create: [CreateSessionInput, CreateSessionOutput];
  resume: [ResumeSessionInput, ResumeSessionOutput];
  close: [CloseSessionInput, CloseSessionOutput];
  list: [ListSessionsInput, ListSessionsOutput];
  rename: [RenameSessionInput, RenameSessionOutput];
  delete: [DeleteSessionInput, DeleteSessionOutput];
  prompt: [PromptInput, PromptOutput];
  interrupt: [InterruptInput, InterruptOutput];
  setModel: [SetModelInput, SetModelOutput];
  getConfigOption: [GetConfigOptionInput, GetConfigOptionOutput];
  setConfigOption: [SetConfigOptionInput, SetConfigOptionOutput];
  respondAgentRequest: [RespondAgentRequestInput, RespondAgentRequestOutput];
  getStatus: [GetStatusInput, GetStatusOutput];
  getMessages: [GetMessagesInput, GetMessagesOutput];
  getSnapshot: [GetSnapshotInput, GetSnapshotOutput];
  subscribe: [SubscribeSessionInput, SubscribeSessionOutput];
  globalSubscribe: [SubscribeGlobalInput, SubscribeGlobalOutput];
};
```

## 7. 事件流协议

### 7.1 流拓扑与恢复来源

服务端维护两类逻辑流：

- 一条 global 流，只发送 `session.created`、`session.deleted`、`session.renamed`。
- 每个活跃或 crash 终态 Session 一条 session 流，只发送该 Session 的实时事件。

所有订阅传输同一个 `ServerEvent` 联合，但不建立通用事件日志；除 active-turn chunk 外，事件不承诺断线重放，各类状态各有恢复来源：

- global 集合状态：`project.list` + 对 UI 跟踪的 projectId 调用 `session.list`。global 流不保存回放窗口、不接受 cursor，事件只是集合失效通知——收到 created/deleted/renamed 后按 `event.ref.projectId` 重拉对应 Session 列表；重连或订阅被终止后重复 subscribe + list，不补发断线期间的 global 事件。
- Session 普通运行时状态：`SessionRuntimeSnapshot`。
- 已提交消息：`session.getMessages -> UIMessage[]`。
- 当前 active turn 的 `session.message.chunk`：唯一支持短期内存重放的事件（§7.2、§7.3）。

不存在“一条订阅接收所有 Session 实时内容”的 firehose。同一逻辑流可以有多个独立订阅者：事件向所有订阅者广播，各订阅者独立维护 reducer 状态和 StreamingCursor；不同 subscriptionId 之间不存在全局业务顺序，同一 subscriptionId 的 notification 严格按 FIFO 发送（信封与连接内语义见 §4.1）。

### 7.2 Active turn 与 StreamingCursor

每个 SessionRuntime 同时最多有一个 active turn：

```typescript
type ActiveTurnRuntime = {
  turnId: string;
  messageId: string | null;
  headChunkSeq: number;
  chunks: {
    chunkSeq: number;
    chunk: UIMessageChunk;
  }[];
};
```

规则：

- `headChunkSeq` 初始为 0；第一个 `start` chunk 的 chunkSeq 为 1，并确定稳定 `messageId`。
- chunkSeq 只在本 turn 内连续递增；不同 turn 的 chunkSeq 不可比较。
- Server 保存当前 active turn 的全部 `UIMessageChunk`，供新 Renderer 或短暂断线的 Renderer 重建消息。
- v1 不设置 active-turn chunk 数量或字节上限；实现应记录 chunk count/bytes 便于后续根据真实内存数据优化。
- 已完成 turn 不保留 chunk；完整消息由 Agent 原生历史负责。
- buffer 只存在于当前 Server 内存，不写 Session 元数据文件，也不跨 Server 重启恢复。

§6.1 的 `StreamingCursor` 表示 Renderer 已成功归并的最后一个 chunk。它只在以下条件同时成立时有效：

- 仍是同一个 Server SessionRuntime。
- cursor.turnId 仍是当前 active turn。
- Renderer 仍保留归并到 cursor.chunkSeq 的 UIMessage reducer 状态。

因此 cursor 不能脱离对应 reducer 状态单独持久化。WebSocket 短暂断线但 Renderer 状态仍在时可以继续使用；Renderer reload、状态丢失或 Server 重启后不传 cursor。

### 7.3 Session subscribe 的原子边界与 chunk replay

`session.subscribe` 不暂停 Agent、其他订阅者或当前 turn。它只为新订阅建立一个 paused FIFO queue，并在 SessionRuntime 的同一次串行执行中完成：

```text
1. 校验 StreamingCursor
2. 捕获当前 activeTurn 和 headChunkSeq
3. 按 cursor 捕获需要 replay 的 chunk 范围
4. 创建 paused subscriber 和独立 live FIFO queue
5. 注册 subscriber
6. 同步复制 SessionRuntimeSnapshot
7. 返回 SubscribeSessionOutput
```

这段临界区只能读取内存，内部不能 `await`。所有 Session 状态更新、chunk 编号、buffer 写入和事件发布也必须经过同一个串行 SessionRuntime 入口，并遵守“先更新状态，再向订阅队列发布事件”。

边界建立后 Agent 可以继续产生事件：

- 普通事件和新 chunk 追加到 paused subscriber 的 live queue。
- JSON-RPC success response 写入 WebSocket 之前，不发送该 subscriptionId 的 notification。
- response 写入成功后，pump 先从共享 active-turn buffer 顺序读取捕获的 replay 范围，再排干 live queue，最后切换为正常 live；两阶段不能交错。
- response 写入失败时取消订阅并释放 queue。

例如原子边界的 headChunkSeq 为 10，在 response 发送前又产生 chunk 11、12，则线上顺序仍是：

```text
subscribe success response
replay chunk ...10
live chunk 11
live chunk 12
```

`session.getSnapshot` 是独立的瞬时查询，不与一个订阅共享原子边界；fresh load 和重连应使用 `session.subscribe` response 中的 snapshot。

服务端根据订阅建立时捕获的 active turn 选择 replay：

- 没有 active turn：不重放 chunk。
- 未传 streamingCursor：从 chunk 1 重放到边界 headChunkSeq。
- cursor.turnId 等于 active turnId：只重放 `chunkSeq > cursor.chunkSeq` 且不大于边界 headChunkSeq 的 chunk。
- cursor.turnId 不等于 active turnId：旧 cursor 失效，从当前 turn 的 chunk 1 开始重放；客户端必须先按 §7.4 用 committed history 收敛并清除旧 turn projection，再初始化新 turn reducer。
- cursor.turnId 相同但 chunkSeq 小于 0、不是 safe integer 或大于 headChunkSeq：返回 `INVALID_ARGUMENT`；客户端丢弃本地 reducer 状态后可不带 cursor 重试。
- replay 可能再次发送 Renderer 已处理过的 chunk；客户端按 `{ turnId, chunkSeq }` 幂等忽略（下方消费算法）。

replay 完成后继续发送边界之后进入 live queue 的事件。服务端不能把 live chunk 插入 replay 中间。

Renderer 对 chunk 执行：

```text
chunkSeq <= lastAppliedChunkSeq
  -> 重复，忽略

chunkSeq == lastAppliedChunkSeq + 1
  -> 交给 UIMessageChunk reducer，成功后推进 cursor

chunkSeq > lastAppliedChunkSeq + 1
  -> 检测到缺口，终止当前消费并用最后成功 cursor 重订
```

如果 Renderer 没有对应的 reducer 状态，即使保存了 cursor 也必须丢弃 cursor 并请求完整 replay。

### 7.4 历史与流式消息合并

历史和 active turn 有不同真相源：

```text
已提交消息
  -> session.getMessages
  -> UIMessage[]

当前 active turn
  -> session.message.chunk
  -> UIMessageChunk
  -> Renderer reducer
  -> 临时 assistant UIMessage
```

`getMessages` 不返回仍在运行的 active turn。不过 `getMessages` 是异步历史读取，turn 可能在 subscribe snapshot 之后、历史读取完成之前提交，因此返回结果可能已经包含 snapshot 中 active turn 的最终 UIMessage。

fresh load 必须按以下顺序：

```text
session.subscribe
  -> 得到原子 SessionRuntimeSnapshot
  -> 客户端开始缓冲 subscription events

session.getMessages
  -> 得到 committed UIMessage[]

初始化历史状态
  -> 按 message ID 决定是否需要 active-turn reducer
  -> 顺序排干已缓冲事件
  -> 进入正常 live reduce
```

合并不变量：

1. committed `UIMessage[]` 的顺序和内容是已完成历史的权威来源。
2. streaming projection 只在其 message ID 不存在于 committed history 时追加到历史尾部。
3. 如果 committed history 已包含 `snapshot.activeTurn.messageId`，说明该 turn 在 snapshot 之后已经提交；客户端丢弃该 turn 的临时 projection，并忽略其已缓冲或随后到达的 replay chunk。
4. 如果 snapshot.activeTurn.messageId 仍为 null，则以该 turn 的第一个 `start` chunk.messageId 做同样检查。
5. 普通事件仍按 FIFO 应用；只丢弃已经被 committed UIMessage 覆盖的 message chunk。
6. 收到 `session.turn.ended` 后重新调用 `getMessages`，并以相同 ID 的最终 UIMessage 替换临时 streaming projection。
7. streaming projection 只有在其 turnId 仍等于当前 runtime 状态的 activeTurnId 时才允许保留；重订时该状态来自最新 snapshot，live 消费时由 turn 事件更新。如果 activeTurn 为 null 或已经是另一个 turn，committed history（包括“没有对应 assistant 消息”）胜出，旧 projection 必须删除。

```typescript
function mergeCommittedAndStreaming(
  committed: UIMessage[],
  streaming: {
    turnId: string;
    message: UIMessage;
  } | null,
  currentActiveTurnId: string | null,
): UIMessage[] {
  if (streaming === null || streaming.turnId !== currentActiveTurnId) {
    return committed;
  }

  const committedIds = new Set(committed.map((message) => message.id));

  return committedIds.has(streaming.message.id) ? committed : [...committed, streaming.message];
}
```

Adapter 必须保证完整 chunk 流归并出的 `UIMessage.id` 与历史路径为同一 Agent Loop 生成的最终 `UIMessage.id` 一致。没有这个不变量，Renderer 无法可靠区分“替换临时消息”和“追加新消息”。

重连时必须显式比较本地 streaming turn 与新 snapshot：

```text
snapshot.activeTurn?.turnId === localStreaming.turnId
  -> 保留本地 reducer 状态
  -> 使用 StreamingCursor 续传缺失 chunk

snapshot.activeTurn?.turnId !== localStreaming.turnId
  -> 暂缓处理新 turn replay
  -> 调用 getMessages 收敛旧 turn
  -> 用 committed history 替换或删除旧 projection
  -> 清除旧 StreamingCursor/reducer
  -> snapshot 有新 active turn 时，再从其 chunk 1 初始化新 reducer
```

这覆盖“带 cursor 重连，但旧 turn 在断线期间已经结束”以及“旧 turn 已结束且新 turn 已开始”两种竞态。

### 7.5 Turn 完成边界

`session.turn.ended` 不仅表示 Agent Loop 已停止，还表示该 turn 的历史提交已经完成。若该 turn 产生了 assistant UIMessage，最终消息此时必须可读；如果在第一个 chunk 前就取消，则允许没有 assistant UIMessage。服务端顺序必须是：

```text
发送最后一个 UIMessageChunk（包括 finish/abort/error）
  -> Agent 原生 turn 结束
  -> 确认该 turn 的历史提交完成，且任何最终 UIMessage 已可由 getMessages 读取
  -> 向现有订阅队列发布 session.turn.ended
  -> activeTurn = null
  -> runtime 释放 active-turn chunk buffer；已经开始的 replay reader 可持有只读引用直到完成
```

客户端收到 `session.turn.ended` 后立即调用 `getMessages`，必须能看到该 turn 已提交的最终历史；产生过 assistant UIMessage 时必须包含该消息。历史始终无法读取时不能发布正常 completed；Session 转为 crashed，chunk buffer 保留到 runtime 被 close、resume 或销毁。

### 7.6 订阅终止与恢复

每个订阅者有独立有界 live 发送队列，默认 256 个待发送 notification。replay 直接从共享 active-turn buffer 顺序读取，不复制进该有界队列；replay 期间新产生的 live 事件仍进入 live queue。发布方永不等待慢订阅者；队列满时只终止该订阅者，不影响其他订阅者。

v1 不定义逐事件 ACK 或 `subscription.ack`：WebSocket 保证当前连接内的可靠有序传输，`chunkSeq` 只用于 active-turn replay、重复过滤和缺口检测。

订阅或流终止的全部情形：

| 情形               | 服务端行为                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 慢订阅者           | 经不受队列容量限制的独立路径发送 `subscription.closed(reason='slow_consumer')`，然后删除该订阅                                                     |
| 客户端 unsubscribe | success response 写入后不得再发送该 subscriptionId 的 notification（幂等与返回值见 §4.1）                                                          |
| WebSocket 断开     | 清理该连接的全部订阅，无法保证发送 closed notification（§4.1）                                                                                     |
| `close`            | 发送 `subscription.closed(reason='session_closed')`；销毁 runtime、active-turn buffer 和 session 流，历史及 Session 元数据文件保留                 |
| 正常 turn 结束     | 不终止订阅：按 §7.5 提交历史并释放唯一 active-turn buffer，session 流继续存在                                                                      |
| crash              | 发布 `session.crashed`；保留当前 runtime 状态和内存 chunk buffer，直到 resume、close 或 delete——同一 Server 进程内的新订阅仍可重建已产生的部分消息 |
| `resume`           | 关闭旧订阅并使用新 runtime；旧 StreamingCursor 失效                                                                                                |
| `delete`           | 发送 `subscription.closed(reason='session_deleted')`；关闭实例并删除流、原生历史和 Session 元数据文件                                              |
| graceful shutdown  | 尽力发送 `subscription.closed(reason='server_shutdown')`；不持久化 active-turn buffer                                                              |

被终止或断线后的重订规则：

- 客户端仍保留 active-turn reducer 状态时，带最后成功应用的 `StreamingCursor` 重订；状态已丢失时不带 cursor，由服务端从当前 turn 的 chunk 1 重放（§7.3）。
- 重订拿到 snapshot 后，按 §7.4 的重连收敛规则处理旧 turn projection，再处理可能存在的新 active turn replay。
- global 订阅按 §7.1 的 subscribe + list 恢复。

Server 重启后 session 流不存在，`session.subscribe` 返回 `SESSION_NOT_ACTIVE`；调用方先 resume，再读取 committed history。重启前尚未提交的临时 streaming projection 不保证恢复。

事件协议不生成业务心跳；WebSocket 传输层用 ping/pong 检测连接存活。

## 8. 其余模块契约

### 8.1 harness

```typescript
type AgentInputCapabilities = {
  text: true;
  file: {
    supported: boolean;
    mediaTypes?: string[];
    maxBytes?: number;
  };
};

type HarnessAgentDescriptor = {
  id: HarnessAgentId;
  label: string;
  supportedProtocols: ProviderProtocol[];
  inputCapabilities: AgentInputCapabilities;
  configSchema: ConfigSchemaEntry[];
};

type ListHarnessOutput = {
  harnessAgents: HarnessAgentDescriptor[];
};

type HarnessStatusInput = {
  harnessAgentId: HarnessAgentId;
};

type HarnessStatusOutput = {
  available: boolean;
  reason?: string;
};
```

v1 方法：

- `harness.list`
- `harness.status`

登录流程不在 v1。

### 8.2 project

```typescript
type Project = {
  id: ProjectId;
  name: string;
  cwd: string;
  createdAt: string;
};

type ListProjectsOutput = {
  projects: Project[];
};

type CreateProjectInput = {
  cwd: string;
  name?: string;
};

type CreateProjectOutput = Project;

type RemoveProjectInput = {
  projectId: ProjectId;
};

type RemoveProjectOutput = void;
```

规则：

- `id` 是 Server 生成的 UUID。
- cwd 经过 realpath 和 allowedRoots 校验后按规范路径去重。
- 同一规范 cwd 重复 create 时返回已有 Project，不生成新 UUID。
- name 缺省为目录名。
- remove 只删除 Server 簿记，不删除磁盘目录。
- Project 下仍有 Session 元数据文件时 remove 返回 `CONFLICT`。

### 8.3 fs

fs 与 Project 无强关联，调用方直接传 cwd。所有路径都受 §4.3 的工作区边界约束。

```typescript
type ReadFileInput = {
  cwd: string;
  path: string;
};

type ReadFileOutput = {
  content: string;
};

type FsTreeInput = {
  cwd: string;
  path?: string;
  depth?: number;
};

type FsTreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: FsTreeNode[];
};

type FsTreeOutput = {
  root: FsTreeNode;
};

type FsGrepInput = {
  cwd: string;
  pattern: string;
  regex?: boolean;
  caseSensitive?: boolean;
  respectGitignore?: boolean;
  limit?: number;
};

type FsGrepOutput = {
  matches: {
    path: string;
    line: number;
    text: string;
  }[];
};

type FsSearchInput = {
  cwd: string;
  query: string;
  limit?: number;
};

type FsSearchOutput = {
  paths: string[];
};
```

默认值和上限：

- tree depth 默认 4，最大 20。
- grep/search limit 默认 100，最大 1000。
- grep 默认按普通字符串、大小写不敏感、遵守 `.gitignore`。
- 二进制文件和非 UTF-8 文本返回 `UNSUPPORTED`。

### 8.4 git

git 与 Project 无强关联，调用方直接传 cwd。

```typescript
type GitStatusInput = {
  cwd: string;
};

type GitStatusOutput = {
  branch: string | null;
  files: {
    path: string;
    index: string;
    worktree: string;
  }[];
};

type GitBranchInput = {
  cwd: string;
};

type GitBranchOutput = {
  current: string | null;
  defaultBranch: string | null;
  branches: string[];
};
```

v1 只公开：

- `git.status`
- `git.branch`

非 Git 仓库返回 `INVALID_ARGUMENT`。

### 8.5 provider

```typescript
type ProviderProtocol = "anthropic" | "openai-responses";

type Modality = "text" | "image";

type ModelConfig = {
  upstreamId?: string;
  name?: string;
  reasoning?: boolean;
  input?: Modality[];
  contextWindow?: number;
  disabled?: boolean;
};

type ProviderView = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  enabled: boolean;
  builtin: boolean;
  hasCredential: boolean;
  models: Record<string, ModelConfig>;
};
```

v1 不接收或持久化明文 API key。凭证只引用服务端环境变量：

```typescript
type CreateProviderInput = {
  id: string;
  name: string;
  protocol: ProviderProtocol;
  baseURL: string;
  credentialEnv?: string;
  models?: Record<string, ModelConfig>;
};

type CreateProviderOutput = ProviderView;

type UpdateProviderInput = {
  providerId: string;
  name?: string;
  baseURL?: string;
  enabled?: boolean;
  credentialEnv?: string | null;
  models?: Record<string, ModelConfig>;
};

type UpdateProviderOutput = ProviderView;

type ListProvidersInput = {
  harnessAgentId?: HarnessAgentId;
};

type ListProvidersOutput = {
  providers: ProviderView[];
};

type ListModelsInput = {
  providerId?: string;
};

type ListModelsOutput = {
  models: (ModelConfig & {
    providerId: string;
    modelId: string;
  })[];
};

type RemoveProviderInput = {
  providerId: string;
};

type RemoveProviderOutput = void;
```

规则：

- `credentialEnv` 是环境变量名，不是密钥。
- 读接口不返回 `credentialEnv`，只返回 `hasCredential`。
- 自定义 Provider 创建时必须提供 protocol 和 baseURL。
- 内置 Provider 不能删除，只能修改 enabled、baseURL 和 credentialEnv。
- `provider.list({ harnessAgentId })` 按 `supportedProtocols` 过滤。
- `provider.models` 不探测远端 `/models`，只返回内置目录和本地声明。
- `modelId` 是 服务端的稳定引用名；`upstreamId` 缺省等于 `modelId`。

配置文件：

```typescript
type ModelsConfigFile = {
  version: 1;
  providers: Record<
    string,
    {
      name: string;
      protocol: ProviderProtocol;
      baseURL: string;
      enabled?: boolean;
      credentialEnv?: string;
      models?: Record<string, ModelConfig>;
    }
  >;
};
```

## 9. React 状态层

React 状态层依赖 Server client，不直接操作 WebSocket。

Session 状态必须按完整 `SessionRef` 建 key：

```typescript
type SessionKey = `${ProjectId}:${HarnessAgentId}:${string}`;

function sessionKey(ref: SessionRef): SessionKey {
  return `${ref.projectId}:${ref.harnessAgentId}:${ref.sessionId}`;
}
```

```typescript
interface HarnessAgentStore {
  harnessAgents: HarnessAgentDescriptor[];
  sessionSummaries: Record<SessionKey, SessionSummary>;
  sessions: Record<SessionKey, SessionState>;
  connectionStatus: "connecting" | "connected" | "reconnecting" | "disconnected";
}

type StreamingMessageState = {
  turnId: string;
  lastChunkSeq: number;
  message: UIMessage;
};

interface SessionState {
  ref: SessionRef;
  status: SessionStatus;
  config?: SessionConfig;
  configOptions: SessionConfigOption[];
  committedMessages: UIMessage[];
  streamingMessage: StreamingMessageState | null;
  pendingRequests: AgentRequest[];
}
```

Driver 职责：

- 持有一个 client 实例。
- 订阅 `global.subscribe`；fresh load、重连或 slow consumer 后重新调用 `project.list` 和对应的 `session.list`，global 事件只作为按 projectId 重拉列表的失效通知。
- 对被 UI track 的每个 `SessionRef` 建立 session 订阅，并使用 subscribe response 中的 `SessionRuntimeSnapshot` 初始化运行时状态。
- fresh load 时先建立 session 订阅并缓冲 notification，再调用 `getMessages` 获取 committed `UIMessage[]`，最后按 §7.4 排干缓冲事件。
- `UIMessageChunk -> UIMessage` 只在 Renderer 执行；chunk 成功归并后才推进内存中的 `{ turnId, chunkSeq }`。
- committed history 与 streaming projection 具有相同 message ID 时，history 胜出；UI 展示层只追加 history 中尚不存在的 streaming message。
- 收到 `session.turn.ended` 后立即重拉 `getMessages`，用最终历史 UIMessage 替换同 ID 的临时 streaming message。
- WebSocket 短暂断开或 `slow_consumer` 时，若仍保留 reducer 状态，则带最后 `StreamingCursor` 重订；否则丢弃临时 projection，不带 cursor 请求当前 turn 的完整 replay。
- 重订后按 §7.4 的重连收敛规则处理旧 turn projection，再初始化可能存在的新 active turn。
- 不持久化 subscriptionId，也不单独持久化 StreamingCursor；Renderer reload 后从 committed history 和完整 active-turn replay 重建。
- 连接恢复后先恢复 global 流，再恢复被 track 的 session 流。

公开 hook：

| Hook                        | 说明                                              |
| --------------------------- | ------------------------------------------------- |
| `useHarnessAgents()`        | Agent 列表和可用性                                |
| `useSession(ref)`           | 单会话完整状态                                    |
| `useSessionList(projectId)` | Project 下的会话摘要                              |
| `useCreateSession()`        | create action                                     |
| `usePrompt(ref)`            | prompt/steer action                               |
| `useSessionActions(ref)`    | close、interrupt、model、config、request response |

不公开 zustand store 本体，避免业务代码绕过 Driver 修改协议状态。

## 10. 验收标准

实现完成至少满足以下测试。

### 10.1 契约

- WebSocket 成功协商 `vibest.server.v1` subprotocol。
- 所有 request、response、error 和 notification 都符合 JSON-RPC 2.0 envelope。
- parse error、invalid request、method not found、invalid params 使用标准 JSON-RPC 错误码。
- batch、binary message、null/非 safe-integer id 和数组 params 被拒绝。
- 所有 RPC 输入和输出都有共享 schema。
- `global.subscribe` 的 wire output 只包含 subscriptionId；`session.subscribe` 还原子包含 `SessionRuntimeSnapshot`，wire output 不包含 AsyncIterable。
- `session` 方法列表与导出的 client API 完全一致。
- `SessionRef` 固定包含 projectId、harnessAgentId、sessionId。
- `SessionConfig`（成对 providerId/modelId + `options`）是唯一的 Session 配置类型，create/resume/setModel、摘要、快照、事件和元数据复用同一类型。
- session create/resume/list 不接受 cwd，只接受 projectId。
- fs/git 继续接受 cwd，不要求 projectId。
- `ServerEvent` 是唯一的业务事件 wire 联合，所有事件都携带完整 SessionRef，type 使用 `session.*` 点分名称。
- 普通事件不携带通用 seq；只有 `session.message.chunk` 携带 turnId 和 turn 内连续的 chunkSeq。
- `getMessages` 返回 committed `UIMessage[]`，active turn 只通过 `UIMessageChunk` replay/live 表达。
- global.subscribe 只发送 created/deleted/renamed，session.subscribe 只发送目标 Session 的其余事件。
- Provider 读类型不包含密钥或环境变量名。
- `SessionRef` 在服务端、Server client 和 React 状态层中使用同一共享类型。

### 10.2 生命周期

- Project 不存在时 session.create/resume/list 返回 `NOT_FOUND`。
- session.create 使用 projects.json 中的 cwd，调用方无法覆盖。
- create 任一中间步骤失败时无残留进程、Session 元数据文件、活跃实例或流。
- server 重启后 list 可用，运行时操作返回 `SESSION_NOT_ACTIVE`，resume 后恢复。
- close 保留历史和 Session 元数据文件；delete 删除两者。
- crash 状态可以被查询和订阅；resume 会替换 runtime，旧 StreamingCursor 失效。
- setModel/setConfigOption 成功后，Session 元数据文件同步反映最新 `config`。
- resume 后运行时配置恢复为已持久化的显式设置；已失效的项被跳过，resume 仍成功。

### 10.3 事件流

- `session.subscribe` 在同一 SessionRuntime 串行边界内注册 paused subscriber、捕获 runtime snapshot 和 active-turn replay head。
- subscribe success response 先于该 subscriptionId 的第一条 notification。
- 未传 StreamingCursor 时重放当前 turn 的全部 chunk；有效 cursor 只重放同 turn 中 `chunkSeq > cursor.chunkSeq` 的部分。
- replay 严格先于边界之后的 live 事件，不能交错。
- 第一个 chunk 是 `start` 且 messageId 必填；chunkSeq 从 1 连续递增。
- Renderer 对重复 chunk 幂等忽略，对 chunkSeq 缺口重订。
- 普通事件不重放；session 通过 runtime snapshot、global 通过 list 恢复。
- 多个 subscriptionId 可以在一条 WebSocket 上正确分流。
- unsubscribe 幂等，response 返回后不再出现该 subscriptionId 的 notification。
- 服务端终止流时发送最后一条 `subscription.closed` notification。
- 慢订阅者收到 `subscription.closed(reason='slow_consumer')`，快订阅者不受影响。
- Server 重启后 active-turn buffer 和 StreamingCursor 都失效，resume 后只从 committed history 和新 runtime 恢复。
- 测试使用 barrier/controlled scheduler，不依赖 sleep。

### 10.4 消息合并与多客户端

- 一个 Agent Loop 在实时和历史路径上都归一化为一个 assistant UIMessage。
- 完整 chunk 流构造出的 UIMessage.id 与最终历史 UIMessage.id 一致。
- getMessages 永远排除尚未提交的 active turn。
- getMessages 跨过 turn 完成边界、已经返回最终同 ID UIMessage 时，客户端丢弃对应 replay chunk，不产生重复消息。
- 带 cursor 重订但 snapshot.activeTurn 已不是本地 turn 时，客户端调用 getMessages 收敛旧 projection；历史中没有对应 assistant UIMessage 时也必须删除旧临时 projection。
- 旧 turn 收敛完成前不把新 active turn 的 replay chunk 送入旧 reducer。
- `session.turn.ended` 只在该 turn 的历史提交完成后发布；若产生了 assistant UIMessage，此时必须可通过 getMessages 读取。
- turn 中的第二次 prompt 返回当前 turnId。
- 同一 AgentRequest 并发响应只有一个命中原生 resolver。
- `session.model.updated` 和 `session.config.updated` 广播给所有对应 Session 订阅者。
- 断开连接会清理该连接的全部订阅，旧 subscriptionId 在新连接上无效。

### 10.5 安全

- Basic credentials 缺失或错误时，WebSocket upgrade 返回 HTTP 401，不进入 JSON-RPC 层。
- project.create 的 cwd 越过 allowedRoots 被拒绝。
- SessionRef.projectId 不存在时返回 `NOT_FOUND`。
- Project.cwd 失效或越过 allowedRoots 时，session 操作被拒绝。
- fs/git 的直接 cwd 越过 allowedRoots 被拒绝。
- 通过 symlink 逃逸 cwd 被拒绝。
- 错误响应不泄露敏感宿主机路径。
- Provider API 和日志不输出凭证值。
- 未配置密码时不能绑定非 loopback 地址。

## 11. 后续工作

以下内容单独立项，不提前扩展 v1 类型：

- OpenCode 和 Pi 支持。
- skills、MCP、PTY。
- Agent OAuth/API-key 登录流程。
- 图片、文件和远程 URL 输入。
- 明文密钥之外的系统 keychain 支持；v1 只使用环境变量引用。
- Provider 自定义 headers。
- 外部原生会话导入与 Session 元数据重建。
- 活跃会话 idle TTL 和全局实例上限。
- 基于实际 chunk count/bytes 指标评估 active-turn buffer 上限、压缩或临时落盘；v1 先完整保存在内存中。
- 工具卡片与 AI SDK approval UI 状态的进一步整合。
- 会话分叉、回退和 regenerate。
- Git 写能力、文件写入和 watch。

## 12. Adapter 约束（非 wire）

本章只说明外部契约如何落到 Agent，不定义服务端类结构。实现若与本章冲突，以 §6 的 session wire 契约为准。

| 外部能力  | Claude Code           | Codex                     |
| --------- | --------------------- | ------------------------- |
| create    | Agent SDK `query()`   | app-server `thread/start` |
| resume    | SDK resume option     | `thread/resume`           |
| prompt    | inbox push            | `turn/start`              |
| steer     | adapter 合成          | `turn/steer`              |
| interrupt | `query.interrupt()`   | `turn/interrupt`          |
| 历史      | SDK session APIs      | thread APIs               |
| 审批      | `canUseTool` callback | server-to-client RPC      |
| 消息      | SDK message stream    | server notifications      |

SessionService 在调用 adapter 前，必须先用 `SessionRef.projectId` 查询 `Project.cwd`。adapter 只接收已经解析并校验过的 cwd，不接触 projectId 或 ProjectRepository。

Adapter 必须满足：

- create/resume 返回 Agent 原生 `harnessSessionId`。
- prompt 返回 turnId；turn 进行中再次 prompt 实现 steer，单个 Session 同时最多一个 active turn。
- 实时原生增量转换为 `UIMessageChunk`，完整历史转换为 committed `UIMessage[]`；Server 服务端不执行 `UIMessageChunk -> UIMessage` reducer。
- 一个 Agent Loop 的 text、reasoning、tool call、tool result 和多个 step 归一化为一个 assistant UIMessage 的 parts。
- 每个 turn 的第一个 live chunk 必须是带稳定 messageId 的 `start`；完整 chunk 流在 Renderer 中生成的 UIMessage.id，必须等于历史路径生成的最终 UIMessage.id。
- `getMessages` 必须排除当前 active turn，只返回已提交消息。
- 最后一个 chunk 发送完成且该 turn 的历史提交完成后，才能发布 `session.turn.ended`；若产生了 assistant UIMessage，此时最终消息必须可读。
- 除 `session.message.chunk` 外的原生状态变化转换为 §6.12 对应的 `ServerEvent`。
- AgentRequest 的 native 字段保持 JSON 可序列化。
- 不支持的公共能力返回 `UNSUPPORTED`，不能静默忽略。

模型注入：

- Claude Code：endpoint/token 注入子进程环境，model 传给 Agent SDK。
- Codex：model、modelProvider 和 provider config 通过 app-server 请求注入。
- 未显式选择模型时使用 Agent 原生默认值。
- Codex 活跃线程跨 Provider 切换返回 `UNSUPPORTED`。

第三方协议版本、源码路径和生成方式记录在各 adapter 的实现说明中，不复制进本规范。

## 13. 服务端实现边界（非 wire）

本章只保留实现必须遵守的边界，不规定具体类名、依赖注入方式或装配根。对外行为以 §6、§7、§8 为准。

参考实现使用 Egg.js，不使用 TEGG 装饰器或 DI；服务端运行时按 Node.js 验证。具体 package 划分不属于对外契约。

### 13.1 ProjectId 解析

只有 SessionService 依赖 ProjectService：

```text
SessionRef.projectId
  -> $VIBEST_HOME/storage/projects.json
  -> Project { id, cwd }
  -> WorkspaceGuard 校验 cwd
  -> Agent adapter 原生 cwd 参数
```

规则：

- ProjectId 是 UUID。
- 未找到 Project 时返回 `NOT_FOUND`。
- Project.cwd 已失效或越过 allowedRoots 时返回 `FORBIDDEN`。
- session wire、SessionRuntime 和 Agent adapter 之外的调用方不能覆盖 Project.cwd。
- fs/git/PTY 不走 ProjectService，继续校验各自请求中显式传入的 cwd。

### 13.2 存储归属

| 数据                                                                | 存储位置                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| ProjectId、name、cwd                                                | `$VIBEST_HOME/storage/projects.json`                         |
| sessionId、harnessAgentId、harnessSessionId、config                 | `$VIBEST_HOME/storage/sessions/<projectId>/<sessionId>.json` |
| Provider 和模型配置                                                 | `$VIBEST_HOME/models.json`                                   |
| 已提交对话历史和标题                                                | Agent 原生存储                                               |
| 状态、pending requests、唯一 active turn 及其 UIMessageChunk buffer | Session runtime 内存                                         |
| connection-local subscriptionId 和每订阅者 live queue               | 订阅运行时内存                                               |

Session 元数据文件的最小形状：

```typescript
type SessionMetadata = {
  projectId: ProjectId;
  harnessAgentId: HarnessAgentId;
  harnessSessionId: string;
  config?: SessionConfig;
  createdAt: string;
};
```

Session 元数据文件不保存 cwd；cwd 始终通过 projectId 查询 `projects.json`。

### 13.3 必要流程

create：

```text
校验 projectId
  -> 读取并校验 Project.cwd
  -> adapter.create(Project.cwd, input.config)
  -> 生成 sessionId
  -> 写 Session 元数据文件
  -> 建立 runtime/stream
  -> 发布 session.created
  -> 返回 SessionRef
```

resume：

```text
读取 Project 和 Session 元数据文件
  -> 校验两者 projectId 一致
  -> 解析 input.config ?? metadata.config ?? Agent 默认值
  -> adapter.resume(Project.cwd, harnessSessionId, config)
  -> 逐项重放 metadata.config.options（同 setConfigOption 路径，失效项跳过）
  -> 建立新的 runtime/stream；旧 StreamingCursor 失效
  -> 返回 SessionRef
```

list：

```text
读取 sessions/<projectId>/*.json
  -> 使用 Project.cwd 查询各 Agent 原生历史
  -> 按 harnessSessionId 合并摘要
  -> 补充内存状态
```

delete：

```text
关闭活跃 runtime
  -> 删除 Agent 原生历史
  -> 删除 Session 元数据文件和流
  -> 发布 session.deleted
```

### 13.4 实现不变量

- Project 必须先于 Session 存在。
- create 任一步失败都不能留下半初始化的 Session 元数据文件、运行时状态或 Agent 实例。
- `SessionRef.projectId`、Session 元数据文件所在目录和 `SessionMetadata.projectId` 必须一致。
- Project 下存在 Session 元数据文件时，`project.remove` 返回 `CONFLICT`。
- JSON 存储使用临时文件、fsync、rename 原子替换。
- 每个 SessionRuntime 同时最多一个 active turn；该 turn 的全部 UIMessageChunk 只保存在内存中，完成提交后释放。
- SessionRuntime 的状态更新、chunk 编号、buffer 写入、事件发布和 subscribe 边界必须串行化；原子 snapshot 临界区内不能 await。
- Server 服务端不把 UIMessageChunk 聚合成 UIMessage，历史/流式合并只在 Renderer 执行。
- 服务端重启后运行时状态、chunk buffer、StreamingCursor 和流消失，但 Project、Session 元数据文件及已提交 Agent 历史保留。
