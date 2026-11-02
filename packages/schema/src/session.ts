// Session, inbox, and harness contracts shared by the daemon and its clients.
import { Schema } from "effect"

/** An agent's status as its runtime reports it (herdr's five values; another runtime maps to them). vibest adds no values. */
export const AgentStatus = Schema.Literals(["idle", "working", "blocked", "done", "unknown"])
export type AgentStatus = typeof AgentStatus.Type
/** The coordinator's current turn on a session (SPEC §8.1): `open` while a dispatched message is in flight, then how it ended. */
export const TurnState = Schema.Literals(["none", "open", "completed", "failed", "interrupted", "lost", "not_started"])
export type TurnState = typeof TurnState.Type
/** `send` to the session; `report` / `result` / `notice` to its project's coordinator. */
export const InboxKind = Schema.Literals(["send", "report", "result", "notice"])
export type InboxKind = typeof InboxKind.Type
/** `sending`: claimed for delivery, not yet confirmed. `dropped`: nobody was there to take it; never delivered. */
export const InboxStatus = Schema.Literals(["pending", "sending", "delivered", "failed", "dropped"])
export type InboxStatus = typeof InboxStatus.Type

/** A place in a runtime (runtime-port.md §2): the machine the terminal is on and the runtime's own id for it there. Equal terminals encode equal. */
export const RuntimeAddress = Schema.Struct({
  machine: Schema.String,
  id: Schema.String,
})
export type RuntimeAddress = typeof RuntimeAddress.Type

/** Where a caller is: its own runtime socket when it runs inside the runtime, else a runtime session name. The runtime's to read as `Machine.target`. */
export const RuntimeLocation = Schema.Union([
  Schema.Struct({ socketPath: Schema.String }),
  Schema.Struct({ session: Schema.String }),
])
export type RuntimeLocation = typeof RuntimeLocation.Type

/** A machine a caller names: `local`, or a saved machine; `target` is opaque to core (the runtime's to read). */
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

/** No terminal runtime could be chosen for the start (runtime-port.md §4); the message lists every runtime and why. */
export class NoRuntime extends Schema.TaggedError<NoRuntime>()("NoRuntime", { message: Schema.String }) {}

/** The runtime answers but speaks a protocol this vibest was not built for. */
export class RuntimeIncompatible extends Schema.TaggedError<RuntimeIncompatible>()("RuntimeIncompatible", {
  session: Schema.String,
  message: Schema.String,
}) {}

export class NoSuchSession extends Schema.TaggedError<NoSuchSession>()("NoSuchSession", {
  id: Schema.String,
  message: Schema.String,
}) {}
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

/** A session (or the workspace `vibest` opens) could not be started. */
export class LaunchFailed extends Schema.TaggedError<LaunchFailed>()("LaunchFailed", {
  message: Schema.String,
}) {}

export class NotInRepository extends Schema.TaggedError<NotInRepository>()("NotInRepository", { path: Schema.String }) {
  override get message() {
    return `${this.path} is not inside a git repository`
  }
}
