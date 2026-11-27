import type { Effect, Scope } from "effect"

import type {
  AgentEditor,
  MachineHookOptions,
  MachineHooks,
  MachineNote,
  PluginOptions,
  PluginSession,
  SessionFailures,
  SessionHooks,
  SessionSend,
  SessionSendFailed,
  SessionStop,
  SessionStopFailed,
  SubscriptionReport,
} from "../domain.ts"
import type { EventDomain } from "./event.ts"
import type { HarnessDomain } from "./harness.ts"
import type { Hooks, Registration, Transform } from "./registration.ts"
import type { RuntimeDomain } from "./runtime.ts"

export interface AgentDomain {
  readonly transform: Transform<AgentEditor>
}

export interface MachineDomain {
  readonly hook: <Name extends keyof MachineHooks>(
    name: Name,
    callback: (event: MachineHooks[Name]) => Effect.Effect<ReadonlyArray<MachineNote> | void>,
    options?: MachineHookOptions,
  ) => Effect.Effect<Registration, never, Scope.Scope>
}

export interface SessionDomain {
  readonly hook: Hooks<SessionHooks, SessionFailures>
  readonly list: () => Effect.Effect<ReadonlyArray<PluginSession>>
  readonly get: (id: string) => Effect.Effect<PluginSession | undefined>
  readonly sentIn: (id: string, execution: number) => Effect.Effect<number>
  readonly send: (input: SessionSend) => Effect.Effect<void, SessionSendFailed>
  readonly stop: (id: string, options?: SessionStop) => Effect.Effect<boolean, SessionStopFailed>
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
  readonly session: SessionDomain
}

export interface Plugin {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, Scope.Scope>
}

export const define = (plugin: Plugin) => plugin
