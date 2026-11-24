import type { ExecutionOutcome } from "@vibest/schema/event"
import type { AgentStatus } from "@vibest/schema/session"
import type { Subscription, SubscriptionLimit } from "@vibest/schema/subscription"
import type { SessionRef } from "@vibest/schema/terminal"
import { Schema } from "effect"

export class SessionRefused extends Schema.TaggedError<SessionRefused>()("SessionRefused", { reason: Schema.String }) {}

export class ToolRefused extends Schema.TaggedError<ToolRefused>()("ToolRefused", { reason: Schema.String }) {}

export class SessionSendFailed extends Schema.TaggedError<SessionSendFailed>()("SessionSendFailed", {
  message: Schema.String,
}) {}

export class SessionStopFailed extends Schema.TaggedError<SessionStopFailed>()("SessionStopFailed", {
  message: Schema.String,
}) {}

export interface PluginSession {
  readonly id: string
  readonly projectId: string
  readonly agent: string
  readonly title: string
  readonly parentId: string | null
  readonly to: ReadonlyArray<SessionRef>
  readonly status: AgentStatus
  readonly lastActive: number
  readonly waiting: boolean
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

export interface SessionStop {
  readonly idleSince?: number
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

interface SessionContext {
  readonly project: string
  readonly agent: string
  readonly parentSessionId: string | undefined
  readonly harnesses: ReadonlyArray<HarnessOption>
  readonly subscriptions: ReadonlyArray<Subscription>
}

export interface SessionStartBefore extends SessionContext {
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

export interface SessionToolExecuteBefore {
  readonly session: {
    readonly id: string
    readonly agent: string
    readonly project: string
    readonly projectDir: string
    readonly directory: string
  }
  readonly tool: string
  readonly input: Schema.JsonObject
  readonly cwd: string
}

export interface SessionHooks {
  readonly "start.before": SessionStartBefore
  readonly "tool.execute.before": SessionToolExecuteBefore
}

export interface SessionFailures extends Record<keyof SessionHooks, unknown> {
  readonly "start.before": SessionRefused
  readonly "tool.execute.before": ToolRefused
}

export interface AgentDefinition {
  readonly id: string
  readonly description: string
  readonly system: string
  readonly harness?: string
  readonly provider?: string
  readonly model?: string
}

export interface InvalidAgent {
  readonly id?: string
  readonly source: string
  readonly error: string
}

export interface AgentEditor {
  add(definition: AgentDefinition): void
  invalid(agent: InvalidAgent): void
}

export interface MachineHooks {
  readonly connect: MachineEvent
  readonly remove: MachineEvent
}

export interface MachineHookOptions {
  readonly runtime?: string
}

export type PluginOptions = Schema.JsonObject
