import { type Effect, Schema, type Scope } from "effect"

import type { RuntimeRegistry } from "./runtime.ts"

export * as Plugin from "./plugin.ts"
export * as Runtime from "./runtime.ts"

export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", { reason: Schema.String }) {}

export interface SubscriptionLimit {
  readonly window: string
  readonly percent: number
  readonly status: "available" | "limited"
  readonly resetTime: number | null
}

export interface SubscriptionSnapshot {
  readonly harness: string
  readonly provider: string
  readonly machine: "local"
  readonly account: {
    readonly kind: "subscription" | "api-key" | "none"
    readonly plan?: string | undefined
    readonly provider?: string | undefined
  }
  readonly limits: ReadonlyArray<SubscriptionLimit>
  readonly updatedAt: number
  readonly error?: string | undefined
}

export const isLimited = (row: { readonly limits: ReadonlyArray<{ readonly status: string }> }) =>
  row.limits.some((l) => l.status === "limited")

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
  readonly agentType: string
  readonly parentSessionId: string | undefined
  readonly harnesses: ReadonlyArray<HarnessOption>
  readonly subscriptions: ReadonlyArray<SubscriptionSnapshot>
  readonly attempts: ReadonlyArray<Attempt>
}

export interface AgentStartBefore extends AgentContext {
  prompt: string
  harness: string | undefined
  provider: string | undefined
  model: string | undefined
  machine: { id: string }
  runtime: string | undefined
  readonly parentRuntime: string | undefined
  readonly machines: ReadonlyArray<MachineInfo>
}

export interface AgentFail extends AgentContext {
  readonly sessionId: string
  readonly reason: "limited"
  readonly error: string
  readonly turn: string
  readonly harness: string
  readonly provider: string | undefined
  move: { harness: string; provider?: string | undefined; model?: string | undefined } | undefined
}

export interface Hooks {
  readonly "agent.start.before": { readonly event: AgentStartBefore; readonly error: AgentRefused }
  readonly "agent.fail": { readonly event: AgentFail; readonly error: never }
}

export type HookOf<D extends string> = { [K in keyof Hooks]: K extends `${D}.${infer S}` ? S : never }[keyof Hooks]

export interface Domain<D extends string> {
  readonly hook: <N extends HookOf<D>>(
    name: N,
    callback: (
      event: Hooks[Extract<`${D}.${N}`, keyof Hooks>]["event"],
    ) => Effect.Effect<void, Hooks[Extract<`${D}.${N}`, keyof Hooks>]["error"]>,
  ) => Effect.Effect<void, never, Scope.Scope>
}

export interface Context {
  readonly options: Readonly<Record<string, unknown>>
  readonly agent: Domain<"agent">
  readonly runtime: RuntimeRegistry
  readonly subscription: {
    readonly report: (input: SubscriptionReport) => Effect.Effect<void>
  }
}
