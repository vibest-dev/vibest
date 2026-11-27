import { Event, ExecutionOutcome } from "@vibest/schema/event"
import { MachineName, ProjectId, SessionId } from "@vibest/schema/id"
import { ListedMachine } from "@vibest/schema/machine"
import { MessageStatus } from "@vibest/schema/model"
import { Routing } from "@vibest/schema/plugin"
import { ProjectActivity } from "@vibest/schema/project"
import { AgentStatus, ExecutionState } from "@vibest/schema/session"
import { SessionRef, Terminal } from "@vibest/schema/terminal"
import { Schema, SchemaTransformation } from "effect"

export const BooleanFromQuery = Schema.Literals(["true", "false"]).pipe(
  Schema.decodeTo(
    Schema.Boolean,
    SchemaTransformation.transform({
      decode: (s) => s === "true",
      encode: (b) => (b ? "true" : "false"),
    }),
  ),
)

export const IntFromQuery = Schema.FiniteFromString.check(Schema.isInt())

export const NonNegativeIntFromQuery = Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0))

export const DaemonIdentity = Schema.Struct({
  pid: Schema.optional(Schema.Number),
  instance: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  startedAt: Schema.optional(Schema.Number),
})

export type DaemonIdentity = typeof DaemonIdentity.Type

export const RuntimeStatus = Schema.Struct({
  kind: Schema.String,
  status: Schema.String,
  reason: Schema.optional(Schema.String),
})

export type RuntimeStatus = typeof RuntimeStatus.Type

export const RuntimeDoctor = Schema.Struct({
  kind: Schema.String,
  status: Schema.String,
  reason: Schema.optional(Schema.String),
  name: Schema.String,
  checks: Schema.Array(
    Schema.Struct({
      ok: Schema.Boolean,
      subject: Schema.optional(Schema.String),
      text: Schema.String,
      fix: Schema.optional(Schema.String),
    }),
  ),
})

export const UpdateStatus = Schema.Struct({
  checked: Schema.NullOr(Schema.Number),
  latest: Schema.NullOr(Schema.String),
  checking: Schema.Boolean,
})

export type UpdateStatus = typeof UpdateStatus.Type

export const NOT_CHECKED: UpdateStatus = { checked: null, latest: null, checking: false }

export const PingResult = Schema.Struct({
  protocol: Schema.optional(Schema.Number),
  version: Schema.String,
  runtimes: Schema.optional(Schema.Array(RuntimeStatus)),
  update: Schema.optional(UpdateStatus),
  ...DaemonIdentity.fields,
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})

export type Ping = typeof PingResult.Type

export const GitInfo = Schema.Struct({
  branch: Schema.String,
  pushed: Schema.Boolean,
  saved: Schema.Boolean,
  why: Schema.String,
  unknown: Schema.optional(Schema.String),
})

export const SessionInfo = Schema.Struct({
  id: SessionId,
  name: Schema.String,
  agent: Schema.String,
  harness: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  status: AgentStatus,
  startedAt: Schema.NullOr(Schema.Number),
  exitedAt: Schema.NullOr(Schema.Number),
  executionState: ExecutionState,
  projectId: ProjectId,
  runtime: Schema.String,
  terminal: Schema.NullOr(Terminal),
  worktree: Schema.String,
  repositoryRoot: Schema.NullOr(Schema.String),
  git: Schema.NullOr(GitInfo),
  routing: Schema.optional(Routing),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
  task: Schema.NullOr(Schema.String),
  waitingToStart: Schema.optional(Schema.Literal(true)),
  latest: Schema.NullOr(
    Schema.Struct({
      status: MessageStatus,
      summary: Schema.String,
      endedAt: Schema.NullOr(Schema.Number),
    }),
  ),
  machine: Schema.optional(MachineName),
  view: Schema.optional(Schema.String),
})

export type SessionInfo = typeof SessionInfo.Type

export const SessionReply = Schema.Struct({
  execution: Schema.Number,
  status: ExecutionOutcome,
  text: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  endedAt: Schema.NullOr(Schema.Number),
})

export const SessionStatusInfo = Schema.Struct({
  ...SessionInfo.fields,
  reply: Schema.optional(Schema.NullOr(SessionReply)),
})

export const ProjectRepository = Schema.Struct({
  path: Schema.String,
  identity: Schema.NullOr(Schema.String),
})

export type ProjectRepository = typeof ProjectRepository.Type

export const ProjectRow = Schema.Struct({
  id: ProjectId,
  directory: Schema.NullOr(Schema.String),
  activity: ProjectActivity,
  repositories: Schema.Array(ProjectRepository),
  machine: Schema.optional(MachineName),
})

export type ProjectRow = typeof ProjectRow.Type

export const EdgeMutual = Schema.TaggedStruct("Mutual", { ids: Schema.Array(SessionRef) })

export const EdgeDirected = Schema.TaggedStruct("Directed", {
  from: Schema.Array(SessionRef),
  to: Schema.Array(SessionRef),
})

export const EdgeChain = Schema.TaggedStruct("Chain", { ids: Schema.Array(SessionRef) })

export const EdgeSpec = Schema.Union([EdgeMutual, EdgeDirected, EdgeChain])

export type EdgeSpec = typeof EdgeSpec.Type

export const SessionEdge = Schema.Struct({
  from: SessionRef,
  to: SessionRef,
})

export type SessionEdge = typeof SessionEdge.Type

export const WatchSession = Schema.Struct({
  ...SessionInfo.fields,
  parentId: Schema.NullOr(Schema.String),
  finished: Schema.NullOr(Schema.Number),
  to: Schema.Array(SessionRef),
})

export type WatchSession = typeof WatchSession.Type

export const WatchEvent = Schema.Union([
  Schema.TaggedStruct("Snapshot", {
    projects: Schema.Array(ProjectRow),
    sessions: Schema.Array(WatchSession),
    machines: Schema.Array(ListedMachine),
  }),
  Schema.TaggedStruct("Project", { project: ProjectRow }),
  Schema.TaggedStruct("Session", { session: WatchSession }),
  Schema.TaggedStruct("SessionEnded", {
    id: SessionId,
    projectId: ProjectId,
    machine: Schema.optional(MachineName),
  }),
  Schema.TaggedStruct("Machine", { machine: ListedMachine }),
  Schema.TaggedStruct("MachineRemoved", { name: MachineName }),
])

export type WatchEvent = typeof WatchEvent.Type

export const StoredEvent = Schema.Struct({
  id: Event.ID,
  type: Schema.String,
  created: Schema.Int,
  durable: Event.DurableEnvelope,
  data: Schema.Unknown,
})

export type StoredEvent = typeof StoredEvent.Type
