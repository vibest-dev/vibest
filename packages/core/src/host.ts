import type { AgentFail, Harness as PluginHarness, Runtime as PluginRuntime, SubscriptionReport } from "@vibest/plugin"
import type { HookFailed, PluginInfo, TraceEntry } from "@vibest/schema/plugin"
import type { AgentRefused } from "@vibest/schema/plugin"
import type { HarnessUnavailable, NoRuntime } from "@vibest/schema/session"
import type { Subscription } from "@vibest/schema/subscription"
import type { Effect, Stream } from "effect"

import type { FailInput, MachineEventInput, MachineHook, PluginNote, SpawnDecision, StartInput } from "./plugins.ts"

export type RuntimeDefinition = PluginRuntime.RuntimeDefinition
export type HarnessDefinition = PluginHarness.HarnessDefinition

export type Caller = PluginRuntime.RuntimeCaller & { readonly id: string; readonly name?: string }

export interface RuntimesShape extends PluginRuntime.RuntimeDomain {
  readonly all: Effect.Effect<ReadonlyArray<RuntimeDefinition>>
  readonly route: (id: string) => Effect.Effect<RuntimeDefinition, NoRuntime>
  readonly find: (id: string | null | undefined) => RuntimeDefinition | undefined
  readonly statuses: (
    machine: PluginRuntime.Machine,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly runtime: RuntimeDefinition; readonly status: PluginRuntime.MachineStatus }>
  >
  readonly online: (runtime: RuntimeDefinition, machine: PluginRuntime.Machine) => Effect.Effect<void, NoRuntime>
  readonly callers: Effect.Effect<ReadonlyArray<Caller>>
  readonly added: Stream.Stream<ReadonlyArray<string>>
}

export interface HarnessesShape extends PluginHarness.HarnessDomain {
  readonly all: ReadonlyArray<HarnessDefinition>
  readonly get: (id: string) => Effect.Effect<HarnessDefinition, HarnessUnavailable>
  readonly find: (id: string | null | undefined) => HarnessDefinition | undefined
}

export interface PluginsShape {
  readonly start: (input: StartInput) => Effect.Effect<SpawnDecision, AgentRefused>
  readonly fail: (
    input: FailInput,
  ) => Effect.Effect<{ readonly move: AgentFail["move"]; readonly trace: ReadonlyArray<TraceEntry> }, HookFailed>
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly settled: Effect.Effect<boolean>
  readonly machine: (
    hook: MachineHook,
    event: MachineEventInput,
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
