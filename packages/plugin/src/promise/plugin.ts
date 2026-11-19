import type {
  AgentEditor,
  AgentHooks,
  MachineHookOptions,
  MachineHooks,
  MachineNote,
  PluginOptions,
  PluginSession,
  SessionSend,
  SubscriptionReport,
} from "../domain.ts"
import type { HarnessEditor } from "../effect/harness.ts"
import type { RuntimeEditor } from "../effect/runtime.ts"
import type { EventDomain } from "./event.ts"
import type { Definitions, Registration } from "./registration.ts"

type Awaitable<A> = Promise<A> | A

export interface Context {
  readonly options: PluginOptions
  readonly agent: {
    readonly hook: <Name extends keyof AgentHooks>(
      name: Name,
      callback: (event: AgentHooks[Name]) => Awaitable<void>,
    ) => Promise<Registration>
    readonly transform: (callback: (editor: AgentEditor) => void) => Promise<Registration>
  }
  readonly machine: {
    readonly hook: <Name extends keyof MachineHooks>(
      name: Name,
      callback: (event: MachineHooks[Name]) => Awaitable<ReadonlyArray<MachineNote> | void>,
      options?: MachineHookOptions,
    ) => Promise<Registration>
  }
  readonly runtime: Definitions<RuntimeEditor>
  readonly harness: Definitions<HarnessEditor>
  readonly subscription: { readonly report: (input: SubscriptionReport) => Promise<void> }
  readonly event: EventDomain
  readonly session: {
    readonly list: () => Promise<ReadonlyArray<PluginSession>>
    readonly get: (id: string) => Promise<PluginSession | undefined>
    readonly send: (input: SessionSend) => Promise<void>
  }
}

export type Cleanup = () => Promise<void> | void

export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

export const define = (plugin: Plugin) => plugin
