// @vibest/plugin: what an vibest plugin is written against. vibestd maps this module (and `effect`) to its own instances when it
// loads a plugin, so a plugin imports it normally and never bundles either. See architecture.md §8 and §9.
import { type Effect, Schema, type Scope } from "effect"

import type { RuntimeRegistry } from "./runtime.ts"

export * as Plugin from "./plugin.ts"
export * as Runtime from "./runtime.ts"

/** An `agent.start.before` callback fails with this to refuse the start; vibestd reports the reason and the plugin. */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", { reason: Schema.String }) {}

/** One usage window a plugin, or a poll, reports. `percent` is 0–100. */
export interface SubscriptionLimit {
  readonly window: string
  readonly percent: number
  readonly status: "available" | "limited"
  readonly resetTime: number | null
}

/**
 * One harness login as vibestd last read it. `provider` is empty for Claude Code and Cursor, and set for Pi.
 * `limits` empty means unknown, not unlimited.
 */
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

/** Limits a plugin reports for one `(harness, provider)`. The next poll of a harness that reads usage replaces them. */
export interface SubscriptionReport {
  readonly harness: string
  readonly provider?: string
  readonly limits: ReadonlyArray<SubscriptionLimit>
}

/** One runtime as vibestd last saw it on a machine (runtime-port.md §4, §7). */
export interface MachineRuntime {
  readonly kind: string
  readonly status: "online" | "offline" | "blocked"
  readonly reason?: string | undefined
}

/** One machine as `agent.start.before` reports it: the runtimes on it and the harnesses vibestd could start there. */
export interface MachineInfo {
  readonly machine: string
  readonly runtimes: ReadonlyArray<MachineRuntime>
  readonly harnesses: ReadonlyArray<string>
}

/** A harness vibestd could start, as preflight saw it. */
export interface HarnessOption {
  readonly harness: string
  /** On PATH, logged in, its model list read. false: `problem` says why. */
  readonly available: boolean
  readonly problem?: string | undefined
}

/** One earlier try for this session (a move, or a start that failed or was refused before). */
export interface Attempt {
  readonly harness: string
  readonly provider: string | undefined
  readonly outcome: "limited" | "start_failed" | "not_confirmed" | "unavailable" | "refused"
  readonly at: number
}

/** Read-only context every agent hook gets. */
export interface AgentContext {
  /** The project directory. */
  readonly project: string
  /** `main` for the project's main agent, otherwise the definition (`general`, `reviewer`, …). */
  readonly agentType: string
  /** Who asked; undefined for the main agent and the user's own `vibest run`. */
  readonly parentSessionId: string | undefined
  readonly harnesses: ReadonlyArray<HarnessOption>
  /** Logins and usage windows vibestd has right now, per (harness, provider). */
  readonly subscriptions: ReadonlyArray<SubscriptionSnapshot>
  /** Earlier tries for this session, oldest first; empty on a first start. */
  readonly attempts: ReadonlyArray<Attempt>
}

/**
 * Before any Agent starts, the main agent included. Plugins change the writable fields in place; vibestd runs callbacks
 * one after another in plugin order, so a later plugin sees (and may overwrite) what an earlier one wrote.
 * vibestd validates `harness` and `runtime` after the chain.
 */
export interface AgentStartBefore extends AgentContext {
  /** The caller's text; a plugin may rewrite it. Empty for the main agent. */
  prompt: string
  /** The caller's preference on entry (undefined: none); the builtin default fills it. */
  harness: string | undefined
  provider: string | undefined
  model: string | undefined
  /** The machine to start on (writable; `local` is all there is today). */
  machine: { id: string }
  /** The terminal runtime to start in (writable): a `kind` from `machines`. The builtin choice plugin fills it. */
  runtime: string | undefined
  /** The runtime the parent session runs in (a subagent opens beside its parent, runtime-port.md §4); undefined for the user's own run. */
  readonly parentRuntime: string | undefined
  /** Every machine vibestd knows, with the runtimes on it and the harnesses it could start there (§7). */
  readonly machines: ReadonlyArray<MachineInfo>
}

/**
 * A started Agent's round failed on `reason`. Set `move` to restart the same session on another harness/provider.
 */
export interface AgentFail extends AgentContext {
  readonly sessionId: string
  /** Only reason produced today; the type is a union so more can be added. */
  readonly reason: "limited"
  /** The harness's own error text. */
  readonly error: string
  /** The failed round's text (what will be resent). */
  readonly turn: string
  readonly harness: string
  readonly provider: string | undefined
  move: { harness: string; provider?: string | undefined; model?: string | undefined } | undefined
}

/** Every hook: the event its callbacks get and the error they may fail with. */
export interface Hooks {
  readonly "agent.start.before": { readonly event: AgentStartBefore; readonly error: AgentRefused }
  readonly "agent.fail": { readonly event: AgentFail; readonly error: never }
}

/** The hook names of one domain without its prefix: `start.before` for `agent.start.before`. */
export type HookOf<D extends string> = { [K in keyof Hooks]: K extends `${D}.${infer S}` ? S : never }[keyof Hooks]

export interface Domain<D extends string> {
  /** Registered until the plugin is unloaded (its scope closes). A name not in `Hooks` fails the plugin's setup. */
  readonly hook: <N extends HookOf<D>>(
    name: N,
    callback: (
      event: Hooks[Extract<`${D}.${N}`, keyof Hooks>]["event"],
    ) => Effect.Effect<void, Hooks[Extract<`${D}.${N}`, keyof Hooks>]["error"]>,
  ) => Effect.Effect<void, never, Scope.Scope>
}

export interface Context {
  /** This plugin's `options` from vibest.json. */
  readonly options: Readonly<Record<string, unknown>>
  readonly agent: Domain<"agent">
  /** Register a terminal runtime (`runtime-port.md`). Beside `agent.hook`; kept for the plugin's lifetime. */
  readonly runtime: RuntimeRegistry
  readonly subscription: {
    /** Set the limits for `(harness, provider)` on this machine. Replaces that row's limits until the next usage poll. */
    readonly report: (input: SubscriptionReport) => Effect.Effect<void>
  }
}
