import { AgentFrom } from "@vibest/schema/event"
import { MachineName, ProjectId, RequestId, SessionId } from "@vibest/schema/id"
import { MachineNote, RuntimeThere } from "@vibest/schema/machine"
import { Routing } from "@vibest/schema/plugin"
import { SessionRef, TerminalTarget } from "@vibest/schema/terminal"
import { Schema } from "effect"

export const Attachments = Schema.optional(
  Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.Uint8ArrayFromBase64 })),
)

export const SpawnPayload = Schema.Struct({
  name: Schema.optional(Schema.String),
  prompt: Schema.String,
  harness: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  agent: Schema.String,
  callerEnv: Schema.Record(Schema.String, Schema.String),
  runtimeSession: Schema.optional(Schema.String),
  share: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
  request: Schema.optional(Schema.String),
  machine: Schema.optional(MachineName),
  project: Schema.optional(Schema.String),
  files: Attachments,
  from: Schema.optional(Schema.Array(SessionRef)),
  to: Schema.optional(Schema.Array(SessionRef)),
  with: Schema.optional(Schema.Array(SessionRef)),
})

export type SpawnPayload = typeof SpawnPayload.Type

export const SpawnSuccess = Schema.Struct({
  id: SessionId,
  machine: Schema.optional(MachineName),
  harness: Schema.String,
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  ...Routing.fields,
  notes: Schema.optional(Schema.Array(MachineNote)),
})

export const LaunchPayload = Schema.Struct({
  projectId: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  fresh: Schema.optional(Schema.Boolean),
  move: Schema.optional(Schema.Boolean),
  harness: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String),
  agentNamed: Schema.optional(Schema.Boolean),
  focus: Schema.optional(Schema.Boolean),
  callerEnv: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  runtimeSession: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
  machine: Schema.optional(MachineName),
})

export type LaunchPayload = typeof LaunchPayload.Type

export const LaunchSuccess = Schema.Struct({
  sessionId: SessionId,
  projectId: ProjectId,
  runtime: Schema.String,
  terminal: TerminalTarget,
  place: Schema.String,
  attach: Schema.NullOr(Schema.Array(Schema.String)),
  routing: Schema.optional(Schema.String),
})

export const SendBody = Schema.Struct({
  machine: Schema.optional(MachineName),
  message: Schema.String,
  request: Schema.optional(RequestId),
  from: Schema.optional(AgentFrom),
})

export type SendBody = typeof SendBody.Type

export const AttachPayload = Schema.Struct({
  callerEnv: Schema.Record(Schema.String, Schema.String),
  runtime: Schema.optional(Schema.String),
  sessionId: Schema.optional(Schema.String),
  fresh: Schema.optional(Schema.Boolean),
  agent: Schema.optional(Schema.String),
  agentNamed: Schema.optional(Schema.Boolean),
})

export const AttachSuccess = Schema.Struct({
  projectId: ProjectId,
  directory: Schema.String,
  hasRoot: Schema.Boolean,
  place: Schema.Union([
    Schema.Struct({
      in: Schema.Literals(["terminal"]),
      runtime: Schema.String,
      terminal: TerminalTarget,
    }),
    Schema.Struct({
      in: Schema.Literals(["launch"]),
      runtime: Schema.String,
    }),
  ]),
  running: Schema.NullOr(
    Schema.Struct({
      sessionId: SessionId,
      harness: Schema.String,
      place: Schema.String,
      runtime: Schema.String,
      target: TerminalTarget,
    }),
  ),
})

export const ClaimPayload = Schema.Struct({
  sessionId: Schema.optional(Schema.String),
  harness: Schema.optional(Schema.String),
  agent: Schema.String,
  agentNamed: Schema.optional(Schema.Boolean),
  fresh: Schema.Boolean,
  move: Schema.optional(Schema.Boolean),
  terminal: TerminalTarget,
  runtime: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  pid: Schema.optional(Schema.Number),
})

export const ClaimSuccess = Schema.Struct({
  sessionId: SessionId,
  harnessSessionId: Schema.NullOr(Schema.String),
  projectId: ProjectId,
  runtime: Schema.optional(Schema.String),
  routing: Schema.optional(Schema.String),
  command: Schema.Struct({
    file: Schema.String,
    args: Schema.Array(Schema.String),
    env: Schema.Record(Schema.String, Schema.String),
  }),
})

export const ProjectCreateSuccess = Schema.Struct({
  directory: Schema.String,
  folders: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      source: Schema.String,
      path: Schema.String,
      branch: Schema.String,
      origin: Schema.optional(Schema.String),
      uncommitted: Schema.Array(Schema.String),
    }),
  ),
})

export const RemoteHelloSuccess = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.String,
  runtimes: Schema.optional(Schema.Array(RuntimeThere)),
})

export const RemoteSpawnPayload = Schema.Struct({
  repository: Schema.optional(Schema.String),
  identity: Schema.optional(Schema.String),
  commit: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  repositories: Schema.optional(
    Schema.Array(
      Schema.Struct({
        folder: Schema.String,
        repository: Schema.String,
        identity: Schema.optional(Schema.String),
        commit: Schema.String,
      }),
    ),
  ),
  agent: Schema.String,
  prompt: Schema.String,
  harness: Schema.optional(Schema.String),
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  runtime: Schema.optional(Schema.String),
  request: Schema.String,
  files: Attachments,
})

export type RemoteSpawnPayload = typeof RemoteSpawnPayload.Type

export const RemoteSpawnSuccess = Schema.Struct({
  session: Schema.String,
  harness: Schema.String,
  provider: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  directory: Schema.String,
  ...Routing.fields,
})

export const MachineAddSuccess = Schema.Struct({
  name: MachineName,
  id: Schema.String,
  vibestd: Schema.String,
  version: Schema.String,
  notes: Schema.Array(MachineNote),
})
