import { type Effect, Schema, type Scope, type Types } from "effect"

import type { EventDomain } from "./event.ts"
import type { HarnessDomain } from "./harness.ts"
import type { Hooks, Registration, Transform } from "./registration.ts"
import type { RuntimeDomain } from "./runtime.ts"

export * as Harness from "./harness.ts"
export * as Plugin from "./plugin.ts"
export * as Runtime from "./runtime.ts"
export type { EventDomain, Fact, FactOf, FactType } from "./event.ts"
export type { PromiseContext, PromiseDefinitions, PromiseRegistration } from "./promise.ts"
export type { Hooks, Registration, Transform } from "./registration.ts"
export { capture, type Captured } from "./capture.ts"
export { reconnectSchedule } from "./reconnect.ts"

export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", { reason: Schema.String }) {}

export interface SubscriptionLimit {
  readonly window: string
  readonly percent: number
  readonly status: "available" | "limited"
  readonly resetTime: number | null
}

export interface SubscriptionAccount {
  readonly kind: "subscription" | "api-key" | "none"
  readonly plan?: string | undefined
  readonly provider?: string | undefined
}

export interface SubscriptionSnapshot {
  readonly harness: string
  readonly provider: string
  readonly machine: "local"
  readonly account: SubscriptionAccount
  readonly limits: ReadonlyArray<SubscriptionLimit>
  readonly updatedAt: number
  readonly error?: string | undefined
}

type LimitWindow = {
  readonly status: string
  readonly resetTime?: number | null
  readonly window?: string
}

const resetPassed = (resetTime: number | null | undefined, now: number) =>
  typeof resetTime === "number" && resetTime <= now

const bucketWindow = (window: string | undefined) => window === "monthly-auto" || window === "monthly-api"

const countsAsLimited = (limit: LimitWindow, now: number) =>
  limit.status === "limited" && !bucketWindow(limit.window) && !resetPassed(limit.resetTime, now)

export const isLimited = (row: { readonly limits: ReadonlyArray<LimitWindow> }, now = Date.now()) =>
  row.limits.some((limit) => countsAsLimited(limit, now))

export const exhaustedText = (limits: ReadonlyArray<LimitWindow & { readonly window: string }>, now = Date.now()) =>
  limits
    .filter((limit) => countsAsLimited(limit, now))
    .map((limit) => {
      const reset = limit.resetTime == null ? "no reset time" : `resets ${new Date(limit.resetTime).toISOString()}`
      return `${limit.window} limit exhausted, ${reset}`
    })
    .join("; ")

export const stillLimited = (
  attempt: { readonly harness: string; readonly provider: string | undefined; readonly at: number },
  rows: ReadonlyArray<{
    readonly harness: string
    readonly provider: string
    readonly updatedAt: number
    readonly limits: ReadonlyArray<{ readonly status: string }>
  }>,
) => {
  const row =
    attempt.provider === undefined
      ? undefined
      : rows.find((r) => r.harness === attempt.harness && r.provider === attempt.provider)
  return !(row !== undefined && row.updatedAt > attempt.at && !isLimited(row))
}

export interface SubscriptionReport {
  readonly harness: string
  readonly provider?: string
  readonly limits: ReadonlyArray<SubscriptionLimit>
}

export interface MachineRuntime {
  readonly kind: string
  readonly status: "online" | "offline" | "blocked"
  readonly reason?: string | undefined
}

export interface MachineNote {
  readonly message: string
  readonly fix?: string
}

export interface MachineRuntimeThere extends MachineRuntime {
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

export interface Attempt {
  readonly harness: string
  readonly provider: string | undefined
  readonly outcome: "limited" | "start_failed" | "not_confirmed" | "unavailable" | "refused"
  readonly at: number
}

export interface AgentContext {
  readonly project: string
  readonly agent: string
  readonly parentSessionId: string | undefined
  readonly harnesses: ReadonlyArray<HarnessOption>
  readonly subscriptions: ReadonlyArray<SubscriptionSnapshot>
  readonly attempts: ReadonlyArray<Attempt>
}

export interface AgentStartBefore extends AgentContext {
  readonly prompt: string
  readonly harness: string | undefined
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly machine: { readonly id: string }
  readonly runtime: string | undefined
  readonly parentRuntime: string | undefined
  readonly machines: ReadonlyArray<MachineInfo>
}

export interface AgentFail extends AgentContext {
  readonly sessionId: string
  readonly reason: "limited"
  readonly error: string
  readonly input: string
  readonly harness: string
  readonly provider: string | undefined
}

export interface AgentRoute {
  readonly prompt?: string
  readonly harness?: string | undefined
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly machine?: { readonly id: string }
  readonly runtime?: string | undefined
}

export interface AgentMove {
  readonly harness: string
  readonly provider?: string | undefined
  readonly model?: string | undefined
}

export interface AgentHooks {
  readonly "start.before": AgentStartBefore
  readonly fail: AgentFail
}

export interface AgentResults extends Record<keyof AgentHooks, unknown> {
  readonly "start.before": AgentRoute
  readonly fail: AgentMove
}

export interface AgentFailures extends Record<keyof AgentHooks, unknown> {
  readonly "start.before": AgentRefused
  readonly fail: never
}

export interface GuardCall {
  readonly tool: string
  readonly input: Readonly<Record<string, unknown>>
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
  list(): ReadonlyArray<AgentDefinition>
  get(id: string): AgentDefinition | undefined
  add(definition: AgentDefinition): void
  update(id: string, update: (definition: Types.Mutable<AgentDefinition>) => void): void
  remove(id: string): void
}

export interface AgentDomain {
  readonly hook: Hooks<AgentHooks, AgentResults, AgentFailures>
  readonly transform: Transform<AgentEditor>
}

export interface MachineHooks {
  readonly connect: MachineEvent
  readonly remove: MachineEvent
}

export interface MachineHookOptions {
  readonly runtime?: string
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

export type PluginOptions = Readonly<Record<string, unknown>>

export interface Context {
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly machine: MachineDomain
  readonly runtime: RuntimeDomain
  readonly harness: HarnessDomain
  readonly subscription: SubscriptionDomain
  readonly event: EventDomain
}
