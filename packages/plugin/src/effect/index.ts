import { type Effect, type Scope } from "effect"

import type {
  AgentEditor,
  AgentFailures,
  AgentHooks,
  AgentResults,
  MachineHookOptions,
  MachineHooks,
  MachineNote,
  PluginOptions,
  SubscriptionReport,
} from "../domain.ts"
import type { EventDomain } from "./event.ts"
import type { HarnessDomain } from "./harness.ts"
import type { Hooks, Registration, Transform } from "./registration.ts"
import type { RuntimeDomain } from "./runtime.ts"

export * from "../domain.ts"
export * as Harness from "./harness.ts"
export * as Plugin from "./plugin.ts"
export * as Runtime from "./runtime.ts"
export type { EventDomain, Fact, FactOf, FactType } from "./event.ts"
export type { Hooks, Registration, Transform } from "./registration.ts"
export { capture, type Captured } from "./capture.ts"
export { reconnectSchedule } from "./reconnect.ts"

export interface AgentDomain {
  readonly hook: Hooks<AgentHooks, AgentResults, AgentFailures>
  readonly transform: Transform<AgentEditor>
}

export interface MachineDomain {
  readonly hook: <Name extends keyof MachineHooks>(
    name: Name,
    callback: (event: MachineHooks[Name]) => Effect.Effect<ReadonlyArray<MachineNote> | void>,
    options?: MachineHookOptions,
  ) => Effect.Effect<Registration, never, Scope.Scope>
}

export interface SubscriptionDomain {
  readonly report: (input: SubscriptionReport) => Effect.Effect<void>
}

export interface Context {
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly machine: MachineDomain
  readonly runtime: RuntimeDomain
  readonly harness: HarnessDomain
  readonly subscription: SubscriptionDomain
  readonly event: EventDomain
}
