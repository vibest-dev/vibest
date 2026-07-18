# Harness 权限能力协商设计（HarnessAgentCapabilities）

> 状态：v1 设计定案，等待实现。地基为 PR #119（`origin/t3code/greeting`，session-scoped model and permission mode），非当前 session-streaming worktree。
>
> 本文记录「权限档位如何在 harness 级协商、如何映射到各 agent 原生系统」的定案。被否决的方案（统一 intent 词汇、静态 client 常量表、per-session 探测）与三家源码逐条对照不属于本文，只保留结论。

## 1. 目标与范围

给用户一个**跨 harness 一致、望文生义的权限档位选择**，同时不牺牲各 agent 原生权限系统的语义。

核心结论三条：

1. **权限能力属于 harness，不属于 session**——一个 harness（= 一个外部 agent 进程/连接）的权限档位由其类型 + CLI/SDK 版本决定，同一 harness 下所有 session 一致。应在 harness 初始化时协商一次，而非每开一个 session 重探。
2. **对外只暴露「整体档位」，不暴露细粒度规则**——三家都有「粗档 + 细规则」两层，v1 只做粗档层。
3. **各 harness 声明自己支持的档位子集，不强行对齐**——需求是同一条信任梯度，实现各占其位；给不出的档不声明。

### 1.1 v1 不做

- 细粒度规则层（allow/ask/deny、命令通配符、路径规则、sandbox 细节）。
- 「模型把关」正交维度（Claude `auto` / Codex Guardian auto-review）——见 §7。
- headless 锁定档（Claude `dontAsk`）。
- 运行时「档位可用性 mask」（依版本/平台动态禁用某档）——结构上承认，实现留空，见 §7。

## 2. 背景：为什么是 harness 级协商

参照 **Model Context Protocol** 的 capability negotiation：能力在连接建立时（`initialize`）一次性协商，而非每次调用重来。对应到本项目：

| MCP                    | 本项目                                                                 |
| ---------------------- | ---------------------------------------------------------------------- |
| server / connection    | `HarnessAgentAdapter`（harness 级单例）                                |
| `initialize` 握手      | adapter 的 `capabilities` / `negotiate`（协商一次，所有 session 共享） |
| 连接下的 resource/tool | `HarnessAgentSession`（只持运行时状态）                                |
| `listChanged` 通知     | session 事件流（内容变了才推）                                         |

现状问题：能力挂在 `HarnessAgentSession.getCapabilities`，经 `RPC session.getCapabilities(sessionId)` 每开一个 session 重新探测——等于每个 session 重新握手，违背 MCP 的连接级协商。`HarnessAgentAdapter` 已有 `checkAvailability`（harness 级可用性协商）+ `descriptor`，是 `capabilities` 的正确落点。

**形状 vs 内容**的切分（沿用 MCP capability vs list）：

| 字段       | 形状 → harness 级（协商一次）  | 内容/状态 → session 级（运行时） |
| ---------- | ------------------------------ | -------------------------------- |
| permission | 支持哪些档位                   | 当前选了哪档                     |
| model      | 是否可切、模型全集             | 当前选哪个                       |
| mcp        | 是否支持、支不支持 listChanged | 具体 server 列表 + status        |

v1 只落 permission 的形状层；models/mcp/resume/steering 保持现状，不在本轮迁移。

## 3. 三家权限模型调研（整体档位）

> 来源：官方文档 + GitHub 源码核对（deep-research 工作流因基础设施 bug 未跑通，此为常规 agent 研究 + 一手 protocol 类型，出处见 §8）。

- **Claude Code**（6 个 `permissionMode`）：`plan` · `default` · `acceptEdits` · `auto` · `bypassPermissions` · `dontAsk`
- **Codex**（3 个 TUI 预设，底层 approval × sandbox 二维）：Read Only · Default · Full Access
- **OpenCode**（agent 当预设）：`plan` · `build`

去掉术语后，三家的粗档收敛到一条**信任梯度**：

| 用户意图    | Claude              | Codex             | OpenCode         | 普适                  |
| ----------- | ------------------- | ----------------- | ---------------- | --------------------- |
| 只读 / 规划 | `plan`              | Read Only         | `plan`           | ✅                    |
| 改前审批    | `default`           | Default           | `build`          | ✅                    |
| 自动编辑    | `acceptEdits`       | —（并进 Default） | —（靠规则）      | ⚠️ 仅 Claude 有独立档 |
| 全放开      | `bypassPermissions` | Full Access       | `build`+`--auto` | ✅                    |

## 4. 决策：对外档位 + 命名映射

对外暴露**望文生义的 id**（native 的怪名字如 `default`/`bypassPermissions`/`on-request` 退回 adapter 内部当私有映射，用户永不可见）。语义真正相同的意图各家共用同一 id（`ask`/`full`）；**语义不同的独有档各用各的 id，不强行对齐**——claude 的 `plan` 会产出计划，codex 的 `read-only` 只是纯只读沙箱、不产计划，是两个不同的东西，不共用一个 id：

| 对外 id       | label（用户看）          | claude native              | codex native                     |
| ------------- | ------------------------ | -------------------------- | -------------------------------- |
| `plan`        | 规划（只读 + 产计划）    | `plan`                     | —（codex 无 plan）               |
| `read-only`   | 只读（纯只读，不产计划） | —（claude 由 `plan` 涵盖） | `on-request` + `read-only`       |
| `ask`         | 每步询问                 | `default`                  | `on-request` + `workspace-write` |
| `acceptEdits` | 自动改文件、危险再问     | `acceptEdits`              | —（不声明）                      |
| `full`        | 完全放开、不打断         | `bypassPermissions`        | `never` + `danger-full-access`   |

各 harness 声明的子集：

- `claude-code` → `plan` · `ask` · `acceptEdits` · `full`
- `codex` → `read-only` · `ask` · `full`（无 `plan`/`acceptEdits`）
- `pi` → 不声明 `permissionModes`（= 无权限协议）

## 5. 契约形状（最小）

```ts
// packages/contract
export const HarnessAgentCapabilitiesSchema = Schema.Struct({
  permissionModes: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String, // 各 harness 命名空间内自由，宽松 string 容演进
        label: Schema.String, // harness 自描述，UI 直接渲染（类比 MCP tool 的 name）
      }),
    ),
  ),
});
export type HarnessAgentCapabilities = typeof HarnessAgentCapabilitiesSchema.Type;
```

设计要点：

- **缺省即无能力**：Pi 不声明 `permissionModes` key（比 `supportsPermissions: false` 更贴 MCP——「没这能力」= 「对象里没这字段」）。
- **id 宽松 string**：底层 CLI 升级新增档位，adapter 内部消化即可；契约不用改。
- **label 随 capabilities 下发**：档位各家自由，client 无法静态映射陌生 id，展示信息必须自描述跟着来。
- 旧的封闭四档 `PermissionModeSchema`（Literals）**退休**，语义下沉进各 adapter；`CreateSessionInput.permissionMode` / `SetSessionPermissionModeInput.permissionMode` 入参从封闭类型放宽为 `string`。

## 6. adapter 侧

- `HarnessAgentAdapter` 加 `readonly capabilities: Effect<HarnessAgentCapabilities>`，harness 初始化时协商一次并缓存（与既有 `checkAvailability` 并列，可合成 `negotiate`）。
- 三个 adapter 各声明自己的 `permissionModes` + 各自的 id→native 映射表（claude 直接对应 SDK `permissionMode`；codex 映射到 approval+sandbox 二元组；pi 空）。
- `setPermissionMode` 入参改为对外 id（string），adapter 查自己的表映射回 native。

## 7. 搁置项（结构承认、实现留空）

- **模型把关维度**（正交于信任梯度）：Claude `auto`（分类器 allow/soft_deny/hard_deny）、Codex `on-request` + Guardian auto-review（评风险 low→critical + 批准/拒绝 + rationale，`[UNSTABLE]` 上游明说形状会变）。三家形态各异（mode / guardian 子系统 / 无），**不是** `permissionModes` 里一个平级 id，需单独设计。等 Codex guardian 稳定再做。
- **档位可用性 mask**：将来出现「某版本/平台禁用某档」时，在 session 快照上叠一层动态 mask（`{ id, available, reason? }`）。v1 假设声明即可用。
- **细粒度规则层**：三家都当高级功能，v1 不碰。

## 8. 调研出处

- Claude Code permissions：https://code.claude.com/docs/en/agent-sdk/permissions ，settings：https://code.claude.com/docs/en/settings ，CLI：https://code.claude.com/docs/en/cli-reference
- Codex approval/sandbox：`codex-rs/protocol/src/protocol.rs`、`config_types.rs`；预设：`codex-rs/utils/approval-presets/src/lib.rs`；`--yolo`：`codex-rs/cli/src/main.rs`。**注意**：`on-failure` 已废弃，现 serde alias 到 `on-request`，细粒度改用 `Granular`——本仓库 `packages/harness/src/codex/protocol` 的相关类型已 stale。
- OpenCode：https://opencode.ai/docs/permissions/ 、https://opencode.ai/docs/agents/
