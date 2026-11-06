import { Schema } from "effect"

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"])
export type AgentStatus = typeof AgentStatus.Type
export const TurnState = Schema.Literals(["none", "open", "completed", "failed", "interrupted", "lost", "not_started"])
export type TurnState = typeof TurnState.Type
export const InboxKind = Schema.Literals(["send", "report", "result", "notice"])
export type InboxKind = typeof InboxKind.Type
export const InboxStatus = Schema.Literals(["pending", "sending", "delivered", "failed", "dropped"])
export type InboxStatus = typeof InboxStatus.Type

export const RuntimeAddress = Schema.Struct({
  machine: Schema.String,
  id: Schema.String,
})
export type RuntimeAddress = typeof RuntimeAddress.Type

export const RuntimeLocation = Schema.Union([
  Schema.Struct({ socketPath: Schema.String }),
  Schema.Struct({ session: Schema.String }),
])
export type RuntimeLocation = typeof RuntimeLocation.Type

export const RuntimeMachine = Schema.Struct({
  id: Schema.String,
  target: Schema.optional(Schema.String),
})
export type RuntimeMachine = typeof RuntimeMachine.Type

export const InboxRow = Schema.Struct({
  id: Schema.Number,
  sessionId: Schema.String,
  kind: InboxKind,
  message: Schema.String,
  details: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
  status: InboxStatus,
  createdAt: Schema.Number,
})
export type InboxRow = typeof InboxRow.Type

export const HARNESS_IDS = ["pi", "claude", "cursor"] as const
export type HarnessId = (typeof HARNESS_IDS)[number]
export const isHarnessId = (s: string): s is HarnessId => (HARNESS_IDS as ReadonlyArray<string>).includes(s)

export class HarnessUnavailable extends Schema.TaggedError<HarnessUnavailable>()("HarnessUnavailable", {
  harness: Schema.String,
  message: Schema.String,
}) {}

export class RuntimeUnreachable extends Schema.TaggedError<RuntimeUnreachable>()("RuntimeUnreachable", {
  session: Schema.String,
  message: Schema.String,
}) {}

export class NoRuntime extends Schema.TaggedError<NoRuntime>()("NoRuntime", { message: Schema.String }) {}

export class RuntimeIncompatible extends Schema.TaggedError<RuntimeIncompatible>()("RuntimeIncompatible", {
  session: Schema.String,
  message: Schema.String,
}) {}

export class NoSuchSession extends Schema.TaggedError<NoSuchSession>()("NoSuchSession", {
  id: Schema.String,
  message: Schema.String,
}) {}
export class AmbiguousSession extends Schema.TaggedError<AmbiguousSession>()("AmbiguousSession", {
  prefix: Schema.String,
  matches: Schema.Array(Schema.String),
}) {
  override get message() {
    return `${this.prefix} matches ${this.matches.join(", ")}; give more characters of the session id`
  }
}
export class ProjectMoved extends Schema.TaggedError<ProjectMoved>()("ProjectMoved", {
  projectId: Schema.String,
  from: Schema.String,
  to: Schema.String,
}) {
  override get message() {
    return `the project moved from ${this.from} to ${this.to}; run vibest here to move it`
  }
}
export class AllocationFailed extends Schema.TaggedError<AllocationFailed>()("AllocationFailed", {
  message: Schema.String,
}) {}

export class SessionBusy extends Schema.TaggedError<SessionBusy>()("SessionBusy", {
  id: Schema.String,
  message: Schema.String,
}) {}
export class LimitReached extends Schema.TaggedError<LimitReached>()("LimitReached", { limit: Schema.Number }) {
  override get message() {
    return `VIBEST_MAX_SESSIONS=${this.limit} sessions are already open (working or kept); vibest archive one first`
  }
}
export class NotReady extends Schema.TaggedError<NotReady>()("NotReady", {
  id: Schema.String,
  message: Schema.String,
}) {}
export class NoHarnessChosen extends Schema.TaggedError<NoHarnessChosen>()("NoHarnessChosen", {}) {
  override get message() {
    return "no harness chosen: pass harness, or install a routing plugin"
  }
}

export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  message: Schema.String,
}) {}

export class NotInRepository extends Schema.TaggedError<NotInRepository>()("NotInRepository", { path: Schema.String }) {
  override get message() {
    return `${this.path} is not inside a git repository`
  }
}
