// Plugin contracts the protocol reports: routing traces and plugin status.
import { Schema } from "effect"

/** An `agent.start.before` callback refused the start (or crashed, or timed out: the host says which). */
export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", {
  plugin: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `refused by ${this.plugin}: ${this.reason}`
  }
}

/** An `agent.fail` callback crashed or timed out: that operation fails with this. */
export class HookFailed extends Schema.TaggedError<HookFailed>()("HookFailed", { message: Schema.String }) {}

/** A top-level event field a callback changed. */
export const Change = Schema.Struct({
  field: Schema.String,
  /** Absent when the field was unset before (`from`) or after (`to`). */
  from: Schema.optional(Schema.Unknown),
  to: Schema.optional(Schema.Unknown),
  /** The plugin whose value this replaced. */
  overwrote: Schema.optional(Schema.String),
})

/** One callback's run, in plugin order (plugins.md §5). */
export const TraceEntry = Schema.Struct({
  plugin: Schema.String,
  /** The hook it ran for: `agent.start.before`, `agent.fail`. */
  hook: Schema.String,
  outcome: Schema.Literals(["ok", "refused", "crashed", "timeout"]),
  ms: Schema.Number,
  changes: Schema.Array(Change),
  /** Why it refused the start (`refused`). */
  reason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type TraceEntry = typeof TraceEntry.Type

/** How a session's harness / provider / model were decided; kept on its row as `metadata.routing`. */
export const Routing = Schema.Struct({
  /** Field → the plugin that wrote its final value; absent fields kept their initial value. */
  decidedBy: Schema.Record(Schema.String, Schema.String),
  trace: Schema.Array(TraceEntry),
})
export type Routing = typeof Routing.Type

export const PluginInfo = Schema.Struct({
  /** The plugin id, or the source path when it never loaded far enough to have one. */
  id: Schema.String,
  source: Schema.String,
  revision: Schema.String,
  loadedAt: Schema.Number,
  status: Schema.Literals(["active", "failed"]),
  error: Schema.optional(Schema.String),
  calls: Schema.Number,
  changed: Schema.Number,
  crashed: Schema.Number,
  timedOut: Schema.Number,
  refused: Schema.Number,
  lastError: Schema.optional(Schema.String),
})
export type PluginInfo = typeof PluginInfo.Type
