# negotiate 静态化 + cwd 级运行时目录

> 状态：2026-07-21 方案，取代 [harness-agent-selection-design.md](./harness-agent-selection-design.md) 的 §4（探测）与 §5.2 的一部分。其余各节（harness 在会话创建时固定、三态渲染规则、URL search params）不变。
>
> 起因：把模型探测塞进 `harness.negotiate` 之后，启动被两个 CLI 冷启动拖到 3.65s。但性能只是症状——真正的问题是**这份数据根本不属于 negotiate**。

## 1. 为什么现在的设计是错的

`harness.negotiate` 现在同时回答两个性质完全不同的问题：

| 问题                                   | 答案取决于                           | 变化频率                |
| -------------------------------------- | ------------------------------------ | ----------------------- |
| 有哪些 harness、装了没、支持哪些权限档 | harness 的类型 + CLI 装没装          | 进程生命周期内不变      |
| 有哪些模型                             | 账号 + CLI 版本 + **当前项目的配置** | 每个 project 都可能不同 |

第二行最后那半句是实测出来的，不是推断的。在一个项目里放：

```json
// <project>/.claude/settings.json
{ "env": { "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-sonnet-4-5-20250929" } }
```

同一次 `supportedModels()`，只改 cwd 与 `settingSources`：

```
不读 settings   sonnet => claude-sonnet-5
读 settings     sonnet => claude-sonnet-4-5-20250929
```

id 一样，`resolvedModel` 不一样——**同一个 `sonnet` 在不同项目里跑的是不同的模型**。

而当前实现的探测**根本没有 cwd**（`claude-code/agent.ts` 里一个 `cwd` 字段都没有），它拿的是 server 进程自己的工作目录。于是：

- 对任何真实 project，这份目录都可能是错的；
- 一份错的目录还被缓存到进程结束，供所有 project 共用。

**这是正确性缺陷，性能只是它顺带的代价。** 把 3.65s 优化掉不能修复它——只会让错误答案来得更快。

## 2. 切分

**negotiate 回到静态数据定义；运行时数据按工作目录单独获取。**

```
harness.negotiate()                          静态：有哪些 harness、装没装、权限档
harness.catalog({ cwd, harnessAgentId })     运行时：模型、（未来）skills…
```

判据是一句话：**答案会不会因为换了个项目而改变。**

| 数据                               | 归属      | 依据                                        |
| ---------------------------------- | --------- | ------------------------------------------- |
| `id` / `name`                      | negotiate | 代码里写死的                                |
| `available` / `reason`             | negotiate | 一次 PATH 查找，与项目无关                  |
| `permissionModes`                  | negotiate | harness 的权限词汇表，是它的协议的一部分    |
| `defaultPermissionMode`            | negotiate | 同上，产品对该 harness 的取值               |
| `models` / `defaultModel`          | catalog   | §1 实测：项目 settings 改变 `resolvedModel` |
| skills / agents / commands（未来） | catalog   | 更彻底——`.claude/skills` 就在项目里         |

negotiate 从此不 spawn 任何进程：三次 PATH 查找，亚毫秒，继续阻塞首屏没有任何问题（root loader 保持不变）。

## 3. Contract

`HarnessAgentCapabilitiesSchema` 拆成两半：

```ts
// 留在 negotiate
HarnessAgentCapabilitiesSchema = Struct({
  permissionModes: optionalKey(Array(HarnessAgentPermissionModeSchema)),
  defaultPermissionMode: optionalKey(String),
});

// 新增，per (cwd, harness)
HarnessAgentCatalogSchema = Struct({
  models: optionalKey(Array(HarnessAgentModelSchema)),
  defaultModel: optionalKey(String),
  // skills / agents / slashCommands 后续在这里加，对 wire 是零破坏变更
});
```

`optionalKey` 的语义与既有设计一致且必须保持：**字段缺失 = 该 harness 没有这个维度 = UI 不渲染控件 = `session.create` 不带该字段 = harness 用自己的默认**。

### 3.1 参数是 cwd，不是 projectId

harness 层从来不认识 project。`session/port.ts` 的文档注释已经把这条原则写死了：

> The port speaks the agent-native session id and a resolved `cwd` only — it never sees a projectId or a server sessionId.

catalog 没有理由破这个例。传 projectId 只会让 harness 层反查 `ProjectService`，凭空长出一个它不需要的依赖，就为了拿到那个它真正要的字段。

而且 **cwd 才是这份数据实际依赖的东西**——`.claude/settings.json` 在目录里，不在 project 记录里。用 cwd 做缓存键因此天然是对的：两个 project 指向同一路径时自动共用一份目录，而按 projectId 缓存会把同一份答案算两遍。

调用方拿 cwd 是现成的：`project.create` / `project.list` 都返回 `path`。

### 3.2 单条查询

按 `(cwd, harnessAgentId)` 单条查，不是「一次返回所有 harness」：

- draft 里同一时刻只有一个 harness 被选中，另外两家的目录是纯浪费；
- 一次查一家，切 harness 才触发下一次探测，天然是懒的；
- 一家探测失败不影响另一家（不需要 negotiate 里那套「降级但不缓存」的编排）。

**为什么不做成 `session.capabilities`**：目录在**会话创建之前**就要显示（draft 的模型下拉），而那时还没有 session。cwd 在创建之前就存在。

## 4. 服务端

### 4.1 Adapter

```ts
readonly capabilities: HarnessAgentCapabilities;           // 静态，不变
readonly probeCatalog?: (cwd: string) => Effect<HarnessAgentCatalog, CapabilityProbeFailed>;
```

`probeModels` 变成带 cwd 的 `probeCatalog`（名字放宽，为 skills 留位）。缺席仍表示「这家没有运行时目录」（pi）。

claude-code 侧把 cwd 透给 `query({ options: { cwd } })`——这是修复 §1 那个正确性缺陷的实质动作。

### 4.2 两家的实际依赖并不相同

| harness     | 目录是否随项目变                                                                |
| ----------- | ------------------------------------------------------------------------------- |
| claude-code | **是**。项目 `.claude/settings.json` 的 `env` 块改变 `resolvedModel`（§1 实测） |
| codex       | **否**。`model/list` 的参数里没有 cwd，是 app-server 全局的                     |
| pi          | 无目录                                                                          |

端点统一收 cwd，实现层各自决定怎么用：claude 透给 `query`，codex 直接忽略。**不要因为 codex 现在用不上 cwd 就给它开个不带 cwd 的口子**——它随时可能长出项目级配置，而调用方不该为此改一行。

### 4.3 缓存

缓存键 `(harnessAgentId, cwd)`，成功缓存、失败不缓存（沿用既有理由：一次过期的登录不该把「这家没有模型」钉死到进程结束）。

并发去重仍然需要——两个 tab 开着同一个目录不应各 spawn 一次。既有的 `Semaphore` 移到 catalog 服务，**粒度按 key 而不是全局**，否则两个不同目录的探测会互相排队。

超时保留，但**不再压在启动路径上**，所以可以更宽松地只做「卡死」保护。

### 4.4 探测本身的成本（已落地，保留）

即使挪出启动路径，一次探测仍要 0.7s（claude）/ 3.6s（codex 冷启动），所以已经做的两项优化继续有效：

- `mcpServers: {}` + `strictMcpConfig: true` —— 否则读个模型列表要把用户整个 MCP 集群拉起来；4.3s → 2.7s。
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` —— 官方定义的 autoupdater/telemetry/error-reporting/feedback 总开关；2.7s → 0.7s。

**`settingSources: []` 是被否决的**（还能再省 0.3s）：它正是 §1 那个差异的开关，关掉就等于探测到一份与真实会话不一致的目录。快一点的错答案不是交易。

## 5. UI

### 5.1 启动

root loader 只 await negotiate（静态，亚毫秒）。**首屏不再等任何 CLI。**

### 5.2 draft

draft 现在就要先 `project.create` 才能建会话；把这一步提前到渲染时（而不是提交时），它返回的 `path` 就是 catalog 要的 cwd，`id` 仍然是 `session.create` 要的。

模型下拉的三态，全部落在既有语义里，没有新概念：

| catalog 状态   | 模型下拉                  | 提交                                   |
| -------------- | ------------------------- | -------------------------------------- |
| 未加载         | 骨架 / 禁用               | **不阻塞**——不带 model，harness 用默认 |
| 加载完成       | 正常，初值 `defaultModel` | 带选中的 model                         |
| 无 models 字段 | 不渲染                    | 不带 model                             |

「加载中也能提交」不是妥协，正是 §3 那条 `optionalKey` 语义的自然结果：不选模型本来就是合法的，且与「用户没碰过下拉」完全同义。

切目录或切 harness = 换 query key = 自动重取，与既有的「切 harness 就是 navigate 一次，model/permission 参数自然消失」是同一套机制，不需要任何重置逻辑。

### 5.3 会话内

`SessionRef` 只有 `projectId`，所以这里要多一跳：用现成的 `project.list` 按 id 找到 `path`，再查 catalog。不为此在 SessionRef 上加 cwd——它是 project 记录的属性，复制一份就会有两个可能不同步的真相。

## 6. 这一版顺带修掉的

- 模型目录对每个 project 都可能是错的（§1）——本方案的主要目的。
- 启动被 CLI 冷启动阻塞 3.65s——变成亚毫秒。
- negotiate 里那套「探测失败要降级、降级不能缓存、还不能让权限档跟着消失」的编排整个消失：静态的部分永远不会失败，会失败的部分自己有独立端点和独立的加载态。

## 7. 不做

- **skills / agents / slash commands**：这一版只搬 models，但端点和 schema 按「以后要加」来设计（§3）。
- **catalog 的磁盘持久化缓存**：进程内缓存够用；跨重启的失效判断（CLI 版本、账号切换、订阅变更）复杂度高一档，等有实测诉求再说。
- **daemon 预热**：negotiate 静态化之后，启动已经不等任何东西，预热失去了最主要的动机。真要做也是 catalog 的预热，且应该由「用户最近用的 project」驱动，属于另一个问题。
- **会话配置的持久化**（原设计 §7 遗留）：仍未做，会话内控件显示的仍是默认值而非该会话实际在跑的值。与本方案正交。

## 8. 落地切分

1. **contract 拆分 + catalog 端点**：schema 一分为二，新端点，adapter 的 `probeModels` → `probeCatalog(cwd)`，claude 侧把 cwd 真正透下去（正确性修复），缓存/去重迁移到新服务。negotiate 回退成纯静态。
2. **UI 接线**：draft 提前建 project，模型下拉改用 catalog query，加载态与提交路径按 §5.2。
3. （可选，后续）skills 进 catalog。

① 落地后 negotiate 的返回值会变窄，UI 若还没跟上会短暂看不到模型下拉——所以 ① ② 要连着推，或干脆合成一个 PR。
