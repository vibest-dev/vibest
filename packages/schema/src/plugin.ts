import { Schema } from "effect"

export class AgentRefused extends Schema.TaggedError<AgentRefused>()("AgentRefused", {
  plugin: Schema.String,
  reason: Schema.String,
}) {
  override get message() {
    return `refused by ${this.plugin}: ${this.reason}`
  }
}

export class HookFailed extends Schema.TaggedError<HookFailed>()("HookFailed", { message: Schema.String }) {}

export const Change = Schema.Struct({
  field: Schema.String,
  from: Schema.optional(Schema.Unknown),
  to: Schema.optional(Schema.Unknown),
  overwrote: Schema.optional(Schema.String),
})

export const TraceEntry = Schema.Struct({
  plugin: Schema.String,
  hook: Schema.String,
  outcome: Schema.Literals(["ok", "refused", "crashed", "timeout"]),
  ms: Schema.Number,
  changes: Schema.Array(Change),
  reason: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
})
export type TraceEntry = typeof TraceEntry.Type

export const Routing = Schema.Struct({
  decidedBy: Schema.Record(Schema.String, Schema.String),
  trace: Schema.Array(TraceEntry),
})
export type Routing = typeof Routing.Type

export const PluginInfo = Schema.Struct({
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
