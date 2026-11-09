import type { AgentFail, Harness as PluginHarness, Runtime as PluginRuntime, SubscriptionReport } from "@vibest/plugin"
import type { HookFailed, PluginInfo, TraceEntry } from "@vibest/schema/plugin"
import type { AgentRefused } from "@vibest/schema/plugin"
import type { NoRuntime } from "@vibest/schema/session"
import type { Subscription } from "@vibest/schema/subscription"
import type { Effect } from "effect"

import type { Harness, Harnesses } from "./harness.ts"
import type { FailInput, SpawnDecision, StartInput } from "./plugins.ts"

export type RuntimeDefinition = PluginRuntime.RuntimeDefinition
export type HarnessDefinition = PluginHarness.HarnessDefinition

export type Caller = PluginRuntime.RuntimeCaller & { readonly id: string }

export interface RuntimesShape extends PluginRuntime.RuntimeDomain {
  readonly all: Effect.Effect<ReadonlyArray<RuntimeDefinition>>
  readonly route: (id: string) => Effect.Effect<RuntimeDefinition, NoRuntime>
  readonly statuses: (
    machine: PluginRuntime.Machine,
  ) => Effect.Effect<
    ReadonlyArray<{ readonly runtime: RuntimeDefinition; readonly status: PluginRuntime.MachineStatus }>
  >
  readonly online: (runtime: RuntimeDefinition, machine: PluginRuntime.Machine) => Effect.Effect<void, NoRuntime>
  readonly callers: Effect.Effect<ReadonlyArray<Caller>>
}

export interface HarnessesShape extends PluginHarness.HarnessDomain {
  readonly all: ReadonlyArray<HarnessDefinition>
  readonly get: (id: string) => HarnessDefinition
  readonly find: (id: string | null | undefined) => HarnessDefinition | undefined
}

export interface PluginsShape {
  readonly start: (input: StartInput) => Effect.Effect<SpawnDecision, AgentRefused>
  readonly fail: (
    input: FailInput,
  ) => Effect.Effect<{ readonly move: AgentFail["move"]; readonly trace: ReadonlyArray<TraceEntry> }, HookFailed>
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
}

export interface SubscriptionsShape {
  readonly list: Effect.Effect<ReadonlyArray<Subscription>>
  readonly report: (input: SubscriptionReport) => Effect.Effect<void>
  readonly poll: Effect.Effect<void, never, Harnesses | Harness>
}

export interface HostEnv {
  readonly drop: (names: ReadonlyArray<string>) => void
}
