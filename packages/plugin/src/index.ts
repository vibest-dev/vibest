// @vibest/plugin: what an vibest plugin is written against. vibestd maps this module (and `effect`) to its own instances when it
// loads a plugin, so a plugin imports it normally and never bundles either. See architecture.md §8 and §9.
import { type Effect, Schema, type Scope } from "effect"

import type { AgentRegistry } from "./agent.ts"
import type { HarnessRegistry } from "./harness.ts"
import type { RuntimeRegistry } from "./runtime.ts"

export * as Agent from "./agent.ts"
export * as Harness from "./harness.ts"
export * as Plugin from "./plugin.ts"
export * as Runtime from "./runtime.ts"

/** An `agent.start.before` callback fails with this to refuse the start; vibestd reports the reason and the plugin. */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", { reason: Schema.String }) {}

/** A plugin's action was not done: the session it acts as may not do it, or it failed (the reason says which). */
export class ActionRefused extends Schema.TaggedError<ActionRefused>()("ActionRefused", { reason: Schema.String }) {}

/**
 * What a plugin may do, always as one session (`as`): exactly what that session's own `vibest send` / `vibest run`
 * may, checked the same way (its agent definition's `can`, its project, the entry session's rights for the main
 * agent). A send is from `as`, so the answer to it goes back to `as`; a spawn is `as`'s child.
 */
export interface SessionActions {
  readonly send: (input: {
    readonly as: string
    readonly to: string
    readonly message: string
  }) => Effect.Effect<void, ActionRefused>
  readonly spawn: (input: {
    readonly as: string
    readonly prompt: string
    readonly harness?: string | undefined
    readonly agent?: string | undefined
    readonly name?: string | undefined
    readonly reportTo?: string | undefined
  }) => Effect.Effect<{ readonly id: string }, ActionRefused>
  /**
   * Archive session `id` as `vibest archive` would, only once it has settled: its turn completed, its newest result
   * delivered, its harness idle and nothing queued for it. `as` must be allowed to manage `id` (`null`: the user).
   */
  readonly archive: (input: {
    readonly as: string | null
    readonly id: string
  }) => Effect.Effect<Archived, ActionRefused>
  /**
   * Tell someone about session `about`, as vibest's own notices go: through `agent.notice`, to its live report-to, else
   * its project's entry session, else the user. `to` replaces that route (`[null]`: the user).
   */
  readonly notice: (input: {
    readonly about: string
    readonly kind: AgentNotice["kind"]
    readonly text: string
    readonly to?: ReadonlyArray<string | null> | undefined
  }) => Effect.Effect<void, ActionRefused>
}

/** What `archive` did: nothing yet (`busy`: it has work again), nothing and why (`skipped`), or the archive itself. */
export type Archived =
  | { readonly outcome: "busy" }
  | { readonly outcome: "skipped"; readonly reason: string }
  | {
      readonly outcome: "archived"
      /** Whether the processes its terminal ran are gone (`unknown`: vibest cannot tell). */
      readonly processes: "exited" | "alive" | "unknown"
      readonly pane: "closed" | "kept" | "none"
      readonly worktree: "removed" | "kept" | "gone"
      readonly path: string
      readonly branch: string | null
      /** Why anything was kept. */
      readonly reasons: ReadonlyArray<string>
    }

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

/** One login is limited when any of its usage windows is; no rows means unknown, not limited. */
export const isLimited = (row: { readonly limits: ReadonlyArray<{ readonly status: string }> }) =>
  row.limits.some((l) => l.status === "limited")

/**
 * A remembered limit still rules its login out until that login's own row was refreshed after it and says it is fine
 * again. A login with no row, or none named by the attempt, keeps the plain memory.
 */
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

/**
 * A session's turn ended with a result. `recipients` is where vibest routes it (reply routing: the senders of what the
 * turn consumed, else the session's report-to, else the user when the user asked; `null` is the user); a plugin may
 * rewrite it: forward, fan out, or empty it (the result is then the session's own, read with `vibest result`).
 */
export interface AgentResult {
  readonly sessionId: string
  readonly agentType: string
  readonly status: "completed" | "failed" | "lost"
  /** The harness's last answer text. */
  readonly output: string
  recipients: Array<string | null>
}

/**
 * vibest tells someone about session `sessionId`: it waits on the person (`blocked`), a turn it was sent never started
 * or it never started at all (`not_started`), a message to it was not delivered (`undelivered`), or its archive on
 * completion did not go cleanly (`archived`, from the policy that archives it). `recipients` is where it goes (its live report-to, else its project's
 * entry session, else the user: `null`); a plugin may reword `text` or rewrite `recipients` (empty: nobody is told).
 */
export interface AgentNotice {
  readonly sessionId: string
  readonly agentType: string
  readonly kind: "blocked" | "not_started" | "undelivered" | "archived"
  text: string
  recipients: Array<string | null>
}

/** A session's result reached whom it went to. */
export interface AgentDelivered {
  readonly sessionId: string
  readonly agentType: string
  readonly status: "completed" | "failed" | "lost"
  /** Whoever started it asked for it to be archived once a completed result reached them (`--archive-on-completion`). */
  readonly archiveOnCompletion: boolean
}

/** Every hook: the event its callbacks get and the error they may fail with. */
export interface Hooks {
  readonly "agent.start.before": { readonly event: AgentStartBefore; readonly error: AgentRefused }
  readonly "agent.fail": { readonly event: AgentFail; readonly error: never }
  readonly "agent.result": { readonly event: AgentResult; readonly error: never }
  readonly "agent.notice": { readonly event: AgentNotice; readonly error: never }
  readonly "agent.delivered": { readonly event: AgentDelivered; readonly error: never }
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
  /** Agent hooks, and `define`: what a kind of session may do (kept for the plugin's lifetime). */
  readonly agent: Domain<"agent"> & AgentRegistry
  /** Register a terminal runtime (`runtime-port.md`). Beside `agent.hook`; kept for the plugin's lifetime. */
  readonly runtime: RuntimeRegistry
  /** Register an agent CLI (harness adapter). Kept for the plugin's lifetime, like `runtime.register`. */
  readonly harness: HarnessRegistry
  readonly subscription: {
    /** Set the limits for `(harness, provider)` on this machine. Replaces that row's limits until the next usage poll. */
    readonly report: (input: SubscriptionReport) => Effect.Effect<void>
  }
  /** Send and spawn as a session, bounded by what that session may do. */
  readonly session: SessionActions
}
