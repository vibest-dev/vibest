import type {
  AgentDefinition as PluginAgentDefinition,
  AgentEditor,
  AgentMove,
  Harness as PluginHarness,
  MachineEvent,
  Runtime as PluginRuntime,
  SubscriptionReport,
  Transform,
} from "@vibest/plugin/effect"
import type { HookFailed, PluginInfo, TraceEntry } from "@vibest/schema/plugin"
import type { AgentRefused } from "@vibest/schema/plugin"
import type { HarnessUnavailable, NoRuntime } from "@vibest/schema/session"
import type { Subscription } from "@vibest/schema/subscription"
import type { Effect, Stream } from "effect"

import type { FailInput, MachineHook, PluginNote, SpawnDecision, StartInput } from "./plugins.ts"

export type RuntimeDefinition = PluginRuntime.RuntimeDefinition
export type HarnessDefinition = PluginHarness.HarnessDefinition
export type AgentDefinition = PluginAgentDefinition

export type Caller = PluginRuntime.RuntimeCaller & { readonly id: string; readonly name?: string }

export interface RuntimesShape extends PluginRuntime.RuntimeDomain {
  readonly all: Effect.Effect<ReadonlyArray<RuntimeDefinition>>
  readonly route: (id: string) => Effect.Effect<RuntimeDefinition, NoRuntime>
  readonly find: (id: string | null | undefined) => RuntimeDefinition | undefined
  readonly statuses: Effect.Effect<
    ReadonlyArray<{ readonly runtime: RuntimeDefinition; readonly status: PluginRuntime.RuntimeStatus }>
  >
  readonly online: (runtime: RuntimeDefinition) => Effect.Effect<void, NoRuntime>
  readonly callers: Effect.Effect<ReadonlyArray<Caller>>
  readonly added: Stream.Stream<ReadonlyArray<string>>
}

export interface HarnessesShape extends PluginHarness.HarnessDomain {
  readonly all: ReadonlyArray<HarnessDefinition>
  readonly get: (id: string) => Effect.Effect<HarnessDefinition, HarnessUnavailable>
  readonly find: (id: string | null | undefined) => HarnessDefinition | undefined
}

export interface AgentsShape {
  readonly all: ReadonlyArray<AgentDefinition>
  readonly find: (id: string | null | undefined) => AgentDefinition | undefined
  readonly transform: Transform<AgentEditor>
}

export interface PluginsShape {
  readonly start: (input: StartInput) => Effect.Effect<SpawnDecision, AgentRefused>
  readonly fail: (
    input: FailInput,
  ) => Effect.Effect<{ readonly move: AgentMove | undefined; readonly trace: ReadonlyArray<TraceEntry> }, HookFailed>
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly settled: Effect.Effect<boolean>
  readonly machine: (
    hook: MachineHook,
    event: MachineEvent,
    runtime?: string,
  ) => Effect.Effect<{ readonly plugins: ReadonlyArray<string>; readonly notes: ReadonlyArray<PluginNote> }>
}

export interface SubscriptionsShape {
  readonly list: Effect.Effect<ReadonlyArray<Subscription>>
  readonly report: (input: SubscriptionReport) => Effect.Effect<void>
  readonly poll: Effect.Effect<void>
}

export interface HostEnv {
  readonly drop: (names: ReadonlyArray<string>) => void
}
