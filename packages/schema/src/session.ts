import { Schema } from "effect"

import { InboxKind } from "./event.ts"

export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"])
export type AgentStatus = typeof AgentStatus.Type
export const ExecutionState = Schema.Literals([
  "none",
  "open",
  "completed",
  "failed",
  "interrupted",
  "lost",
  "not_started",
])
export type ExecutionState = typeof ExecutionState.Type
export const InboxStatus = Schema.Literals(["pending", "delivering", "delivered", "failed", "dropped"])
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
  sender: Schema.NullOr(Schema.String),
  recipient: Schema.NullOr(Schema.String),
  kind: InboxKind,
  message: Schema.String,
  status: InboxStatus,
})
export type InboxRow = typeof InboxRow.Type

export type HarnessId = string

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
export class NoCallingSession extends Schema.TaggedError<NoCallingSession>()("NoCallingSession", {}) {
  override get message() {
    return "vibest run is run by an agent in a session; to start working, run vibest in a terminal"
  }
}
export class NoHarnessChosen extends Schema.TaggedError<NoHarnessChosen>()("NoHarnessChosen", {}) {
  override get message() {
    return "no harness to inherit: name one, for example `vibest run claude -- <prompt>`"
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
