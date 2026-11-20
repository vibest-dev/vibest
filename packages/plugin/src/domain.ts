import type { ExecutionOutcome } from "@vibest/schema/event"
import type { AgentStatus } from "@vibest/schema/session"
import type { Subscription, SubscriptionLimit } from "@vibest/schema/subscription"
import { Schema } from "effect"

export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", { reason: Schema.String }) {}

export class SessionSendFailed extends Schema.TaggedError<SessionSendFailed>()("SessionSendFailed", {
  message: Schema.String,
}) {}

export interface PluginSession {
  readonly id: string
  readonly title: string
  readonly parentId: string | null
  readonly status: AgentStatus
  readonly latest: {
    readonly execution: number
    readonly outcome: ExecutionOutcome
    readonly sent: number
    readonly endedAt: number
  } | null
}

export interface SessionSend {
  readonly to: string
  readonly message: string
  readonly request?: string
}

export interface SubscriptionReport {
  readonly harness: string
  readonly provider?: string
  readonly limits: ReadonlyArray<SubscriptionLimit>
}

interface MachineRuntime {
  readonly kind: string
  readonly status: "online" | "offline" | "blocked"
  readonly reason?: string | undefined
}

export interface MachineNote {
  readonly message: string
  readonly fix?: string
}

interface MachineRuntimeThere extends MachineRuntime {
  readonly link?: Readonly<Record<string, string>> | undefined
}

export interface MachineEvent {
  readonly name: string
  readonly target: string
  readonly vibestd: string
  readonly runtimes: ReadonlyArray<MachineRuntimeThere>
}

export interface MachineInfo {
  readonly machine: string
  readonly runtimes: ReadonlyArray<MachineRuntime>
  readonly harnesses: ReadonlyArray<string>
}

export interface HarnessOption {
  readonly harness: string
  readonly available: boolean
  readonly problem?: string | undefined
}

interface AgentContext {
  readonly project: string
  readonly agent: string
  readonly parentSessionId: string | undefined
  readonly harnesses: ReadonlyArray<HarnessOption>
  readonly subscriptions: ReadonlyArray<Subscription>
}

export interface AgentStartBefore extends AgentContext {
  prompt: string
  readonly files: ReadonlyArray<string>
  harness: string | undefined
  provider: string | undefined
  model: string | undefined
  machine: { readonly id: string }
  runtime: string | undefined
  readonly parentRuntime: string | undefined
  readonly machines: ReadonlyArray<MachineInfo>
}

export interface AgentHooks {
  readonly "start.before": AgentStartBefore
}

export interface AgentFailures extends Record<keyof AgentHooks, unknown> {
  readonly "start.before": AgentRefused
}

export interface GuardCall {
  readonly tool: string
  readonly input: Schema.JsonObject
  readonly cwd: string
  readonly programs: ReadonlyArray<ReadonlyArray<string>>
  readonly writes: ReadonlyArray<string> | undefined
  readonly session: {
    readonly id: string
    readonly projectFolder: string
    readonly harnessBinaries: ReadonlySet<string>
    readonly runtimePrograms: ReadonlySet<string>
  }
}

export interface AgentDefinition {
  readonly id: string
  readonly description: string
  readonly system: string
  readonly guard?: (call: GuardCall) => string | undefined
}

export interface AgentEditor {
  add(definition: AgentDefinition): void
}

export interface MachineHooks {
  readonly connect: MachineEvent
  readonly remove: MachineEvent
}

export interface MachineHookOptions {
  readonly runtime?: string
}

export type PluginOptions = Schema.JsonObject
