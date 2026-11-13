import type { Effect, Scope } from "effect"

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

interface SubscriptionDomain {
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

export interface Plugin {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, Scope.Scope>
}

export const define = (plugin: Plugin) => plugin
