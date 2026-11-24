import type * as VibestPlugin from "@vibest/plugin/effect"
import type { MachineEvent } from "@vibest/plugin/effect"
import type { AgentRefused, PluginInfo, PluginsNotActive, Routing } from "@vibest/schema/plugin"
import { Context, type Effect } from "effect"

export type MachineHook = keyof VibestPlugin.MachineHooks

export interface PluginNote extends VibestPlugin.MachineNote {
  readonly plugin?: string
}

export type StartInput = Omit<VibestPlugin.AgentStartBefore, "subscriptions" | "files"> & {
  readonly files?: ReadonlyArray<string>
}

export interface SpawnDecision extends Routing {
  readonly prompt: string
  readonly harness: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly machine: { readonly id: string }
  readonly runtime: string | undefined
}

export interface Interface {
  readonly start: (
    input: StartInput,
    decidedBy?: Readonly<Record<string, string>>,
  ) => Effect.Effect<SpawnDecision, AgentRefused | PluginsNotActive>
  readonly guard: (event: VibestPlugin.AgentToolBefore) => Effect.Effect<string | undefined>
  readonly list: Effect.Effect<ReadonlyArray<PluginInfo>>
  readonly settled: Effect.Effect<boolean>
  readonly machine: (
    hook: MachineHook,
    event: MachineEvent,
    runtime?: string,
  ) => Effect.Effect<{ readonly plugins: ReadonlyArray<string>; readonly notes: ReadonlyArray<PluginNote> }>
}

export class Service extends Context.Service<Service, Interface>()("vibest/Plugins") {}
