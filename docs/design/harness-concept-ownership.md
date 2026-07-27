# harness 概念归属:语义归谁 × 拿它贵不贵

> 取代 `harness-config-setting-model.md` 与 `connection-initialize-handshake.md`(两者已删)。
> 修订 `harness-static-negotiation-and-project-catalog.md` 定下的分类轴。

## 1. 问题:分类轴选错了

今天 harness 的对外数据按**获取成本**切成两半:

- `HarnessAgentCapabilities` —— 纯值,零成本,随 `negotiate` 一起给。装 `permissionModes`。
- `HarnessAgentCatalog` —— 要 spawn CLI、按目录,`catalog` 懒取。装 `models`。

这个切法看起来成立,是因为**巧合共线**:permissionMode 恰好便宜,model 恰好贵。轴本身是实现属性(拿它贵不贵),却被用来决定数据形状与渲染归属。一旦出现「语义我们要理解、但只能探测才知道」的东西——codex 的 sandbox 在某些平台不可用,而这正是我们要 branch 的语义——这个结构就装不下。

**更深一层:我们缺一条判据,来决定一个 native 概念该被「归一化」还是「透传」。** 现状已经自相矛盾:

- `domain.ts` 说 permissionMode 的 `id` 是「the harness's **own outward vocabulary**」(=透传);而产品意图是跨 harness 统一几档(=归一化)。注释和意图相反。
- 实际声明不共享词表:claude-code 是 `plan / ask / acceptEdits / full`,codex 是 `read-only / ask / full`。
- 同时我们的代码**确实在 branch 它**:`plan` 档关联整条 plan 审批流程(`AgentRequest` 的 `"plan"` 分支、`PlanApprovalMode`)。这不是搬运,这是理解。

一度考虑过的泛型 `Setting { key, label, options, default }` 错在同一个地方:把两种性质不同的东西塞进一个结构,`label` 被迫上 wire(server 下发 UI 渲染指令,i18n 死、配不了图标/危险色),我们自己定义的闭集被降级成运行时字符串。

## 2. 判据

> **在 adapter 边界之外,vibest 是否需要 branch on 这个值的语义。**

需要 → **归一化**;不需要、只是搬运和展示 → **透传**。

边界很重要:**adapter 内部当然知道自己 harness 的 native 语义,那正是它的职责**。判据管的是 adapter 之外:contract、server 通用层、client。

判据可执行、可检查:上述三处出现一个 `if (x === "…")`,就说明 `x` 已经被偷偷归一化了,它必须在归一化通道里有正式定义。

## 3. 两个通道

### 3.1 归一化(normalized)—— 语义归 vibest

契约里定闭集。**闭集是并集,不是交集**:成员是「我们向用户承诺的档」,不是「某个 harness 恰好有的档」。

```ts
export const PermissionModeSchema = Schema.Literals([
  "plan", // 先出计划、批准后执行 —— 触发我们的 plan 审批流程
  "read-only", // 只读,不产出计划(codex 的 read-only sandbox)
  "ask", // 写操作/命令逐次审批
  "acceptEdits", // 文件编辑自动放行,命令仍审批
  "full", // 不审批(各 harness 的"不审批"强度不同,见下)
]);
```

`plan` 与 `read-only` 并存是有意的:把 codex 的 read-only 映射成 `plan` 会撒谎 —— codex 不产出计划、不触发 plan 审批。强行取交集或硬映射都是有损的。

adapter 只声明「这几档我支持哪些」,类型收窄到 union:

```ts
readonly permissionModes: ReadonlyArray<PermissionMode>;   // 空 = 没有权限概念(pi)
readonly defaultPermissionMode?: PermissionMode;
```

往 native 的映射是 adapter 私有知识:claude 的 `full` → `bypassPermissions`(只跳过提示);codex 的 `full` → `approvalPolicy: never` + `dangerFullAccess`(连沙箱都没了)。强度差异由 `defaultPermissionMode` 表达(codex 默认 `ask`)。

**显示归 client**:文案、说明、图标、危险色、顺序,全在前端一张表。词是我们的,显示就是我们的事。

**值域校验在 RPC 边界**:传进来的档不在该 harness 的子集里 → `INVALID_ARGUMENT`。闭集意味着 client 拥有全部信息,传错是 bug,不静默忽略。

### 3.2 透传(opaque)—— 语义归 harness

harness 定义开集,我们不认识。规则:

- `label` **必须**由来源给 —— 只有它认识这个值。前端渲染 `label ?? id`。
- **禁止**在 adapter 之外对其值做任何语义判断。
- **id 是原子的**:不许解析、不许拼接、不许比较子串。id 的内部结构也是语义,语义归定义者。harness 若把 provider 编进 id(`"openai/gpt-5"`),编解码都是它 adapter 的私事。
- 不跨来源:换了 harness/provider,旧选择作废(client 现有的「不在列表里就忽略」规则保留)。

### 3.3 两个通道不合并

形态不同,失败策略也不同,合并必牺牲一边:

|            | 归一化                    | 透传                                |
| ---------- | ------------------------- | ----------------------------------- |
| 值域定义者 | vibest(契约 union)        | 来源(探测结果)                      |
| 声明的是   | 支持哪些成员(能力子集)    | 值域列表                            |
| 显示文案   | client 持有               | 来源给                              |
| 类型       | 编译期 union              | 运行时 string                       |
| 传了非法值 | `INVALID_ARGUMENT` 硬失败 | best-effort:跳过、回退默认,会话照开 |
| skew 风险  | 有(见 §9)                 | 无                                  |

失败策略那行是不能合并的铁证:归一化传错是 client bug(闭集,信息完整),必须响亮失败;透传传错很正常(探测列表会过期、URL 带旧 model id),硬失败会把「列表有点旧」变成「建不了会话」。**一个 `setConfig(key, value: string)` 无法同时做对这两件事。**

### 3.4 透传值不是标量:伴生属性与级联

model 不是一个 string,是**透传 id + 归一化伴生属性**的复合体。两家的探测结果都带能力字段,现状全被丢掉:

|                           | claude `ModelInfo`                         | codex `Model`                                          |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| reasoning reasoningEffort | `supportsEffort` / `supportedEffortLevels` | `supportedReasoningEfforts` / `defaultReasoningEffort` |
| 输入模态                  | —                                          | `inputModalities`                                      |

按判据,这些**必须归一化** —— 我们要 branch:reasoningEffort 决定渲不渲染 reasoningEffort 选择器;modalities 是 `PromptPart.file` 目前一律 `UNSUPPORTED` 的正确答案。

```ts
export const ReasoningEffortSchema = Schema.Literals([
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export const InputModalitySchema = Schema.Literals(["text", "image"]);

// 一个 model 的描述(ModelInfoSchema):id 透传,traits 归一化
export const ModelInfoSchema = Schema.Struct({
  id: Schema.String, // 原子,原样回传
  label: Schema.optionalKey(Schema.String),
  reasoningEfforts: Schema.optionalKey(Schema.Array(ReasoningEffortSchema)), // 缺席 = 无 reasoningEffort 概念
  defaultReasoningEffort: Schema.optionalKey(ReasoningEffortSchema),
  modalities: Schema.optionalKey(Schema.Array(InputModalitySchema)), // 缺席 = 只当 text
});
```

adapter 把 native 能力映射进这些闭集,**不认识的值丢弃**(旧 client 遇到新 harness 能力,最坏是少个开关,不会错)。

这里出现了原框架没有的东西:**级联**。reasoningEffort 的类型是闭集(归一化),但**值域来自当前选中的 model**(探测得来、随选择变)。推论:

- reasoningEffort 的候选从 `selectedModel.reasoningEfforts` 读,不从 harness 读;
- reasoningEffort 校验按透传通道的策略走 best-effort(值域源自探测、会过期),尽管它的类型是归一化的 —— **失败策略跟着值域的来源走,不跟类型走**;
- reasoningEffort 是独立的设置,有自己的写路径;级联是**行为规则,不是数据结构**:`setModel` 时 server 把 reasoningEffort 重置为新 model 的默认,client 想要别的档再 `setReasoningEffort` 一次。这样杜绝「codex 的 xhigh 挂在 claude 的 model 上」的悬空组合,又不把两个概念焊进一个 wire 对象。

**演化规则同理:透传值需要被 branch 时,不整体归一化,而是析出归一化伴生属性。** 我们永远不维护模型清单,但可以理解模型的能力。

## 4. Provider 抽象:harness 是第一个 provider

**model 的来源是 provider,不是 harness。** 今天每个 harness 恰好自带唯一一个 provider(它自己的模型目录),所以两者看起来重合 —— 这又是一次巧合共线,和 §1 那次同构。将来用户可配置自己的 model provider(OpenAI 兼容端点),模型来源就不止 harness 自身了。

三家后端的现实(调查结论):

- claude-code:provider 是进程级隐式常量(凭据决定,不可选),`ModelInfo` 上没有 provider 字段;
- codex:`modelProvider` 存在且与 model 平级(thread 级),但协议**无法枚举** provider,`model/list` 也不标注归属;
- pi:没有 model,也没有 provider。

所以**不能做两级 provider→model 选择器**,那个结构三家里两家填不满。正确做法是把 provider 做成**归属层**而不是选择层:

```ts
// 模型的完全限定寻址是平铺的一对字段,永远同进同出(provider 内 modelId 才唯一,
// 半对即客户端 bug)。不设包装类型:两个 id 就是两个 id。
providerId: string; // 路由键,client 不 branch 其值
modelId: string; // 透传,原子
```

规则:

- **provider 拥有 models,models 永不脱离 provider 扁平化**。(仓库里已经犯过一次:`provider/service.ts` 的 `listModels` 把 models flatMap 后丢掉 providerId,调用方拿不回归属。)
- **今天:每个 harness 注册一个内建 provider,`providerId = harnessAgentId`。** 探测该 provider = 调 harness 的 `probeModels`。UI 上单 provider 时归属不可见,不加一层假选择。
- **将来:用户配置的 provider 实现同一个接口**,进同一个注册表;harness 通过一个归一化能力声明它能否消费外部 provider(claude-code/codex 不能,只认自己;将来能接任意端点的 harness 声明能)。session 创建时校验 `providerId` 对该 harness 合法,不合法 → `UNSUPPORTED`。
- `providerId` 对 client 是**路由键**:参与复合键、参与分组显示,但 client 不对其值做语义判断 —— 它既不是归一化(我们不 branch 具体值)也不完全透传(格式是我们定的),和 `sessionId` 同类。
- 既有的 `ProviderConfig`(`packages/server/src/types/index.ts`,用户自配端点,未接线)就是这个接口未来的第二个实现,本轮不动(见 §11)。

命名词汇表(契约层两个对称类型 + 一对平铺 id,与 `HarnessAgentInfo` 的既有惯例一致):

- **`ProviderInfo`** —— 谁提供(目录的描述):`{ id, label?, models[] }`;
- **`ModelInfo`** —— 是什么(一个 model 的描述):`{ id, label?, reasoningEfforts?, defaultReasoningEffort?, modalities? }`;
- **`providerId` + `modelId`** —— 指哪个:平铺的字段对,不设包装类型,同进同出。

代码纪律:装 `ModelInfo` 的变量叫 `model`/`modelInfo`;寻址永远是两个平铺参数/字段。**Info 描述,id 对寻址** —— 不引入裸名 `Model`(与 codex 协议类型撞名),不再使用 `ProviderModel`/`ModelProvider` 这对镜像词,也不设 `ModelRef` 包装(第三个概念名不值得为一对 id 存在)。

## 5. 正交维:获取成本

只决定加载策略与失败模式,不进数据形状:

- **declared** —— 纯值,零成本,随连接给,不会失败。
- **probed(cwd)** —— spawn CLI:懒加载、缓存、按目录,**可失败,且失败必须与「不支持」可区分**。

|                | declared                | probed(cwd)                                                         |
| -------------- | ----------------------- | ------------------------------------------------------------------- |
| **normalized** | `permissionMode`        | model 的 `reasoningEfforts`/`modalities`;codex sandbox 可用性(将来) |
| **opaque**     | 固定 profile 列表(将来) | `model.id`                                                          |

右列上格已经不是「将来」了:model traits 就是「归一化 + 探测得来」,今天的结构装不下它,新结构里它只是 probe 返回里的闭集字段。

## 6. 契约形状

```ts
// 便宜、连接级、不会失败
harness.list: () => {
  harnessAgents: ReadonlyArray<{
    id: HarnessAgentId;
    name: string;
    available: boolean;
    reason?: string;
    permissionModes: ReadonlyArray<PermissionMode>;   // 空数组 = 无此概念
    defaultPermissionMode?: PermissionMode;
  }>;
}

// 贵、按目录、会失败;按 provider 归组返回
harness.probe: (input: { harnessAgentId: HarnessAgentId; cwd: string }) => {
  providers: ReadonlyArray<ProviderInfo>;
}

// ProviderInfo(ProviderInfoSchema)
{
  id: string;                        // 今天恒等于 harnessAgentId
  label?: string;
  models: ReadonlyArray<ModelInfo>;  // §3.4 的形状
}
```

- `negotiate` → **`list`**:它从来只是在列 harness(真协商见 §9)。
- `catalog` → **`probe`**:名字直说代价 —— 贵、会失败。**失败不许吞成空结果**:登录过期被缓存成「没有模型选择」是最坏的静默错误。错误走错误通道,前端渲染「取不到/重试」,与「本来就没有 model」区分。
- `permissionModes` 必填数组,空数组表达「没有」(可选+空是双重表达)。
- **model 没有默认标记 —— 默认由缺席表达。** 目录里的 "default" 标志(codex 的 `isDefault`、claude 清单里的 "Default (recommended)" 条目)是 provider 的建议或一个普通可选项,**不是**未配置会话实际会跑什么 —— 那由 harness 自己的用户配置(`config.toml` / settings)决定,探测不到。所以 client 从不预选、从不代用户提交一个默认:没选 → 控件显示占位 → wire 省略字段 → harness 自己定。(claude 的 "Default (recommended)" 作为普通模型条目照常可选 —— 它的语义「让 CLI 决定」是一个真实选项。)

写路径 —— 每个设置一个 setter,不发明合并概念:

```ts
session.create: { projectId; harnessAgentId; permissionMode?: PermissionMode; providerId?; modelId?; reasoningEffort?: ReasoningEffort }
session.setPermissionMode: { ref; mode: PermissionMode }     // 闭集,INVALID_ARGUMENT
session.setModel: { ref; providerId; modelId }               // best-effort,回退默认;并将 reasoningEffort 重置为新 model 的默认
session.setReasoningEffort: { ref; reasoningEffort: ReasoningEffort }          // best-effort(值域来自当前 model 的探测结果)
```

## 7. server / adapter 形状

```ts
// adapter
readonly permissionModes: ReadonlyArray<PermissionMode>;
readonly defaultPermissionMode?: PermissionMode;
/** 内建 provider 的探测。cwd 照收(codex 忽略),调用方不 branch 谁在乎。 */
readonly probeModels?: (cwd: string) => Effect<ReadonlyArray<ModelInfo>, CapabilityProbeFailed>;
```

- `capabilities` 套壳删除 —— 「静态那一半」不再是一个概念,字段直接挂 adapter。
- server 通用层持一个 **provider 注册表**:今天只注册各 harness 的内建 provider(id = harnessAgentId,probe 委托给 adapter);用户自配 provider 将来进同一表。probe 缓存键 = `(providerId, cwd)`;失败不缓存成空。
- session 的 `setModel(selection)`:server 核验 `providerId` 是该 harness 可消费的(今天 = 只许它自己,否则 `UNSUPPORTED`),然后把 `modelId`/`reasoningEffort` 交 adapter;adapter 内部翻译成 native(codex:reasoningEffort 上 `turn/start`;claude:SDK setModel)。
- `applyInitialSessionConfig` 按通道分裂:permissionMode 失败是真故障(RPC 边界已校验过);model/reasoningEffort 失败跳过、回退默认,会话照开。

## 8. 前端形状

```ts
// 唯一一处权限档展示知识;顺序也归 client
const PERMISSION_MODES: Record<PermissionMode, { label; description; tone?: "danger" }> = { ... };
const PERMISSION_MODE_ORDER: ReadonlyArray<PermissionMode> = [...];
```

- 权限选择器读 `PERMISSION_MODES`,可配图标、说明、`full` 危险提示;模型选择器只渲染 `label ?? id`,多 provider 时按 provider 分组(今天单组,不显示组头)。这个不对称是对的。
- reasoningEffort 选择器的候选来自 `selectedModel.reasoningEfforts`,换 model 重置为 `defaultReasoningEffort`;`reasoningEfforts` 缺席则不渲染。
- `SessionConfigOption { id, label }` 删除 —— 它是把两个通道抹平的中间类型。
- 「不在列表里就忽略」「没声明就不渲染控件」两条规则保留。

## 9. 握手退化成一个版本号

skew 的暴露面只有归一化那一半:透传通道 client 本来不认识值,新 model 顶多显示裸 id;归一化闭集(权限档、reasoningEffort、modality)由我们定义、变化很慢,且 adapter 对不认识的 native 值做丢弃,新增成员对旧 client 只是「少个选项」。

```ts
initialize: () => {
  protocolVersion: string;
  serverInfo: {
    name: string;
    version: string;
  }
};
```

对不上就提示升级。不做 capabilities 树、`supported[]` 矩阵、三步握手 —— 那是开放协议(MCP)在任意 client × 任意 server 下才需要的;我们是同一 monorepo 的两半,唯一真实场景是新 client 连远程旧 server。

## 10. 演化规则

| 新东西                   | 走哪条                                   |
| ------------------------ | ---------------------------------------- |
| 我们要 branch 的         | 契约加 union + 声明子集 + 前端文案表     |
| 不 branch 的             | `{ id, label? }[]` 进 probe 返回         |
| 要 branch 但值域来自探测 | probe 返回里的闭集字段(traits 模式,§3.4) |
| 新的模型来源             | 实现 provider 接口进注册表,不动契约形状  |

## 11. 非目标

- **用户自配 provider 的 RPC/UI** —— 本轮只留 seam(providerId/modelId 字段对、注册表、harness 的可消费声明),`ProviderConfig` 不接线。
- **会话配置持久化** —— 既有缺口,与本文正交。
- **`PromptInputSchema.model`** —— 与 session 级 `setModel` 重复,本轮或紧随其后删除。
- **skills / agents / slash commands** —— 归属明确(透传 + probed),不实现。
- **多版本兼容矩阵** —— §9 只声明版本。

## 12. 逐层改动

| 层                                                              | 改动                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contract/src/domain.ts`                               | 加 `PermissionModeSchema` / `ReasoningEffortSchema` / `InputModalitySchema`;删带 label 的 `HarnessAgentPermissionMode`;`HarnessAgentCapabilities` 拆平进 `HarnessAgentInfo`;catalog 形状 → provider 归组的 probe 输出;create/set 输入按 §6(providerId/modelId 平铺) |
| `packages/contract/src/harness.ts`                              | `negotiate` → `list`,`catalog` → `probe`;「失败不许吞」入注释与错误映射                                                                                                                                                                                             |
| `packages/server/src/harness/adapter.ts`                        | 去 `capabilities` 套壳;`probeCatalog` → `probeModels`(输出带 traits);`applyInitialSessionConfig` 分裂失败策略                                                                                                                                                       |
| `packages/server/src/harness/{claude-code,codex,pi}/adapter.ts` | 权限声明改 `PermissionMode[]`(去 label);traits 映射(claude reasoningEffort levels / codex reasoningEfforts+modalities);pi 不变                                                                                                                                      |
| `packages/server/src/harness/{negotiation,catalog}.ts`          | 改名;引入 provider 注册表;缓存键 `(providerId, cwd)`,失败不缓存                                                                                                                                                                                                     |
| `apps/app/src/core/harness/session-config.ts`                   | 删 `SessionConfigOption`;权限档走文案表;按维度独立的纯函数解析器(候选来源各异,不设捆绑类型),model 用平铺 id 对,reasoningEffort 从选中 model 的 traits 级联                                                                                                          |
| `apps/app/src/components/chat/*`                                | 权限选择器读 `PERMISSION_MODES`;模型选择器 provider 分组(单组隐藏)+ reasoningEffort 选择器                                                                                                                                                                          |
