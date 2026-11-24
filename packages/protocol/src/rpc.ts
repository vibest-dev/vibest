import { ArchiveOutcome } from "@vibest/schema/archive"
import { AgentFrom, ExecutionOutcome } from "@vibest/schema/event"
import { MachineName, RequestId } from "@vibest/schema/id"
import {
  AlreadyAdded,
  ListedMachine,
  MachineFailed,
  MachineIncompatible,
  MachineInfo,
  MachineLoad,
  MachineNote,
  MachineUnavailable,
  NoCommit,
  NoProject,
  OutboxItem,
  PromptTooLarge,
  RuntimeThere,
  UnknownMachine,
} from "@vibest/schema/machine"
import { MessageStatus } from "@vibest/schema/model"
import { SessionRefused, PluginInfo, PluginsNotActive, Routing } from "@vibest/schema/plugin"
import {
  NoSuchProject,
  CloneFailed,
  CloneRequest,
  CloneStep,
  ProjectActivity,
  ProjectCreateFailed,
  ProjectInfoResult,
  ProjectSearchInput,
} from "@vibest/schema/project"
import {
  AgentStatus,
  AllocationFailed,
  AmbiguousSession,
  HarnessChoice,
  AgentListing,
  HarnessUnavailable,
  LaunchFailed,
  MoveRefused,
  NoCallingSession,
  NoHarnessChosen,
  NoSuchSession,
  NotInRepository,
  NoRuntime,
  RuntimeIncompatible,
  RuntimeUnreachable,
  SessionBusy,
  Taken,
  UnknownAgent,
  ExecutionState,
} from "@vibest/schema/session"
import { Subscription } from "@vibest/schema/subscription"
import { SessionRef, Terminal, TerminalTarget } from "@vibest/schema/terminal"
import { WorktreeList } from "@vibest/schema/worktree"
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

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

export class ProtocolRejected extends Schema.TaggedError<ProtocolRejected>()("ProtocolRejected", {
  method: Schema.String,
  protocol: Schema.NullOr(Schema.String),
  mismatch: Schema.Struct({
    protocol: Schema.Number,
    version: Schema.String,
    message: Schema.String,
    action: Schema.String,
  }),
}) {
  override get message() {
    return `${this.method} refused: ${this.mismatch.message}`
  }
}

export class InvalidCaller extends Schema.TaggedError<InvalidCaller>()("InvalidCaller", {
  method: Schema.String,
  message: Schema.String,
}) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  method: Schema.String,
  message: Schema.String,
}) {}

export type CallerIdentity =
  | { readonly _tag: "Cli"; readonly repositoryRoot: string }
  | { readonly _tag: "Ui" }
  | {
      readonly _tag: "Session"
      readonly sessionId: string
      readonly projectId: string
      readonly repositoryRoot?: string
    }
  | {
      readonly _tag: "Remote"
      readonly remoteId: string
      readonly projectId?: string
      readonly session?: string
    }

export class Caller extends Context.Service<Caller, CallerIdentity>()("vibest/Caller") {}

export class DaemonStopping extends Schema.TaggedError<DaemonStopping>()("DaemonStopping", { method: Schema.String }) {
  override get message() {
    return `vibestd is stopping to be replaced; ${this.method} was not run and nothing was recorded. Run it again once vibestd is back (vibest status)`
  }
}

export const Blocker = Schema.Struct({ id: Schema.String, reason: Schema.String })

export type Blocker = typeof Blocker.Type

export class DaemonBusy extends Schema.TaggedError<DaemonBusy>()("DaemonBusy", { blockers: Schema.Array(Blocker) }) {
  override get message() {
    return ["vibestd was not stopped; still in use by:", ...this.blockers.map((b) => `  ${b.id}: ${b.reason}`)].join(
      "\n",
    )
  }
}

export class WrongInstance extends Schema.TaggedError<WrongInstance>()("WrongInstance", {
  expected: Schema.String,
  actual: Schema.NullOr(Schema.String),
}) {
  override get message() {
    return `vibestd instance ${this.actual ?? "unknown"} answers, not ${this.expected}; nothing was stopped`
  }
}

export class ProtocolGate extends RpcMiddleware.Service<ProtocolGate>()("vibest/ProtocolGate", {
  error: ProtocolRejected,
}) {}

export class Admission extends RpcMiddleware.Service<Admission>()("vibest/Admission", {
  error: DaemonStopping,
}) {}

export class CallerGate extends RpcMiddleware.Service<CallerGate, { provides: Caller }>()("vibest/CallerGate", {
  error: Schema.Union([InvalidCaller, Forbidden, NoSuchSession]),
}) {}

const RemoteEdges = Schema.Array(
  Schema.Struct({ from: Schema.String, to: Schema.String, remote: Schema.optional(Schema.String) }),
)

const RemoteLinkSpec = {
  payload: { edges: RemoteEdges },
  success: Schema.Struct({ edges: RemoteEdges }),
  error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession]),
}

const protocol = <
  Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires,
>(
  rpc: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>,
) => rpc.middleware(ProtocolGate)

const admitted = <
  Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires,
>(
  rpc: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>,
) => rpc.middleware(Admission)

const scoped = <
  Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires,
>(
  rpc: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>,
) => rpc.middleware(CallerGate).middleware(ProtocolGate)

export const GitInfo = Schema.Struct({
  branch: Schema.String,
  pushed: Schema.Boolean,
  saved: Schema.Boolean,
  why: Schema.String,
  unknown: Schema.optional(Schema.String),
})

export const SessionInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  agent: Schema.String,
  harness: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  status: AgentStatus,
  startedAt: Schema.NullOr(Schema.Number),
  exitedAt: Schema.NullOr(Schema.Number),
  executionState: ExecutionState,
  projectId: Schema.String,
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

const LINE_ERRORS = [UnknownMachine, MachineUnavailable, MachineIncompatible] as const

const PROCESS_ERRORS = Schema.Union([
  Forbidden,
  NoSuchSession,
  AmbiguousSession,
  SessionBusy,
  RuntimeUnreachable,
  NoRuntime,
  ...LINE_ERRORS,
])

export const SessionReply = Schema.Struct({
  execution: Schema.Number,
  status: ExecutionOutcome,
  text: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  endedAt: Schema.Number,
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
  id: Schema.String,
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
    id: Schema.String,
    projectId: Schema.String,
    machine: Schema.optional(MachineName),
  }),
  Schema.TaggedStruct("Machine", { machine: ListedMachine }),
  Schema.TaggedStruct("MachineRemoved", { name: Schema.String }),
])

export type WatchEvent = typeof WatchEvent.Type

export const EventsFact = Schema.Struct({
  aggregate: Schema.String,
  seq: Schema.Number,
  at: Schema.Number,
  type: Schema.String,
  data: Schema.Unknown,
})

export class WatchLagged extends Schema.TaggedError<WatchLagged>()("WatchLagged", { message: Schema.String }) {}

const Attachments = Schema.optional(
  Schema.Array(Schema.Struct({ name: Schema.String, content: Schema.Uint8ArrayFromBase64 })),
)

export class VibestRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: PingResult }),
  scoped(
    admitted(
      Rpc.make("Spawn", {
        payload: {
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
        },
        success: Schema.Struct({
          id: Schema.String,
          machine: Schema.optional(MachineName),
          harness: Schema.String,
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          ...Routing.fields,
          notes: Schema.optional(Schema.Array(MachineNote)),
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          MachineFailed,
          UnknownMachine,
          MachineUnavailable,
          MachineIncompatible,
          NoProject,
          NoCommit,
          PromptTooLarge,
          AllocationFailed,
          HarnessUnavailable,
          NotInRepository,
          NoCallingSession,
          NoHarnessChosen,
          NoRuntime,
          SessionRefused,
          PluginsNotActive,
          UnknownAgent,
          NoSuchSession,
          AmbiguousSession,
          RuntimeUnreachable,
          RuntimeIncompatible,
        ]),
      }),
    ),
  ),
  protocol(Rpc.make("Plugins", { success: Schema.Array(PluginInfo) })),
  protocol(
    Rpc.make("Concurrency", {
      success: Schema.Struct({
        max: Schema.NullOr(Schema.Number),
        problems: Schema.Array(Schema.String),
        unsupported: Schema.Array(Schema.String),
      }),
    }),
  ),
  protocol(
    Rpc.make("Harnesses.List", {
      payload: { provider: Schema.optional(Schema.String), machine: Schema.optional(Schema.String) },
      success: Schema.Array(HarnessChoice),
      error: Schema.Union([Forbidden, ...LINE_ERRORS]),
    }),
  ),
  protocol(
    Rpc.make("Agents.List", {
      payload: { machine: Schema.optional(Schema.String) },
      success: AgentListing,
      error: Schema.Union([Forbidden, ...LINE_ERRORS]),
    }),
  ),
  protocol(
    Rpc.make("Worktree.List", {
      payload: { project: Schema.optional(Schema.String), machine: Schema.optional(Schema.String) },
      success: WorktreeList,
      error: Schema.Union([Forbidden, NoSuchProject, ...LINE_ERRORS]),
    }),
  ),
  scoped(
    Rpc.make("Integration.Guard", {
      payload: { harness: Schema.String, input: Schema.String },
      success: Schema.Struct({ answer: Schema.optional(Schema.Unknown) }),
      error: Schema.Union([HarnessUnavailable, InvalidCaller]),
    }),
  ),
  protocol(
    Rpc.make("Runtimes.Doctor", {
      payload: { harnesses: Schema.Array(Schema.String) },
      success: Schema.Array(RuntimeDoctor),
    }),
  ),
  protocol(Rpc.make("Subscriptions", { success: Schema.Array(Subscription) })),
  protocol(Rpc.make("Republish", { success: Schema.Number })),
  scoped(
    admitted(
      Rpc.make("Launch", {
        payload: {
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
          machine: Schema.optional(Schema.String),
        },
        success: Schema.Struct({
          sessionId: Schema.String,
          projectId: Schema.String,
          runtime: Schema.String,
          terminal: TerminalTarget,
          place: Schema.String,
          attach: Schema.NullOr(Schema.Array(Schema.String)),
          routing: Schema.optional(Schema.String),
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          NotInRepository,
          NoSuchProject,
          NoSuchSession,
          LaunchFailed,
          NoRuntime,
          SessionRefused,
          PluginsNotActive,
          UnknownAgent,
          ...LINE_ERRORS,
        ]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Send", {
        payload: {
          ...SessionRef.fields,
          message: Schema.String,
          request: Schema.optional(RequestId),
          from: Schema.optional(AgentFrom),
        },
        success: SessionRef,
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Interrupt", {
        payload: SessionRef.fields,
        success: Schema.Struct({ ...SessionRef.fields, message: Schema.String }),
        error: PROCESS_ERRORS,
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Stop", {
        payload: SessionRef.fields,
        success: Schema.Struct({ ...SessionRef.fields, message: Schema.String }),
        error: PROCESS_ERRORS,
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Archive", {
        payload: { ...SessionRef.fields, keepWorktree: Schema.optional(Schema.Boolean) },
        success: Schema.NullOr(ArchiveOutcome),
        error: PROCESS_ERRORS,
      }),
    ),
  ),
  scoped(
    Rpc.make("List", {
      payload: { stopped: Schema.optional(Schema.Boolean), all: Schema.optional(Schema.Boolean) },
      success: Schema.Struct({ sessions: Schema.Array(SessionInfo), machines: Schema.Array(ListedMachine) }),
      error: Schema.Union([Forbidden]),
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Session.Link", {
        payload: { spec: EdgeSpec },
        success: Schema.Struct({ edges: Schema.Array(SessionEdge) }),
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Session.Unlink", {
        payload: { spec: EdgeSpec },
        success: Schema.Struct({ edges: Schema.Array(SessionEdge) }),
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS]),
      }),
    ),
  ),
  scoped(
    Rpc.make("Get", {
      payload: SessionRef.fields,
      success: SessionStatusInfo,
      error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS]),
    }),
  ),
  scoped(
    Rpc.make("Peek", {
      payload: { ...SessionRef.fields, lines: Schema.optional(Schema.Number) },
      success: Schema.Struct({
        text: Schema.String,
        terminal: Schema.optional(Terminal),
        view: Schema.optional(Schema.String),
      }),
      error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, NoRuntime, RuntimeUnreachable, ...LINE_ERRORS]),
    }),
  ),
  scoped(Rpc.make("Inbox.Subscribe", { success: Schema.Null, error: Schema.Union([Forbidden]), stream: true })),
  scoped(
    Rpc.make("Inbox.Take", {
      success: Schema.NullOr(Taken),
      error: Schema.Union([Forbidden]),
    }),
  ),
  scoped(
    Rpc.make("Events", {
      payload: {
        session: Schema.optional(Schema.String),
        after: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        follow: Schema.optional(Schema.Boolean),
      },
      success: EventsFact,
      error: Schema.Union([Forbidden, NoSuchSession]),
      stream: true,
    }),
  ),
  scoped(Rpc.make("Watch", { success: WatchEvent, error: Schema.Union([Forbidden, WatchLagged]), stream: true })),
  scoped(
    admitted(
      Rpc.make("Session.Seen", {
        payload: { id: Schema.String, finished: Schema.Number },
        error: Schema.Union([Forbidden, NoSuchSession, RuntimeUnreachable]),
      }),
    ),
  ),
  protocol(
    admitted(
      Rpc.make("ExecutionEnd", {
        payload: { sessionId: Schema.String, harness: Schema.String, event: Schema.String },
      }),
    ),
  ),
  protocol(
    admitted(
      Rpc.make("Prompt", {
        payload: { sessionId: Schema.String, harness: Schema.String, event: Schema.String },
      }),
    ),
  ),
  scoped(
    Rpc.make("Session.Attach", {
      payload: {
        callerEnv: Schema.Record(Schema.String, Schema.String),
        runtime: Schema.optional(Schema.String),
        sessionId: Schema.optional(Schema.String),
        fresh: Schema.optional(Schema.Boolean),
      },
      success: Schema.Struct({
        projectId: Schema.String,
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
            sessionId: Schema.String,
            harness: Schema.String,
            place: Schema.String,
            runtime: Schema.String,
            target: TerminalTarget,
          }),
        ),
      }),
      error: Schema.Union([
        InvalidCaller,
        Forbidden,
        NotInRepository,
        NoSuchSession,
        LaunchFailed,
        RuntimeUnreachable,
        RuntimeIncompatible,
      ]),
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Session.Claim", {
        payload: {
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
        },
        success: Schema.Struct({
          sessionId: Schema.String,
          harnessSessionId: Schema.NullOr(Schema.String),
          projectId: Schema.String,
          runtime: Schema.optional(Schema.String),
          routing: Schema.optional(Schema.String),
          command: Schema.Struct({
            file: Schema.String,
            args: Schema.Array(Schema.String),
            env: Schema.Record(Schema.String, Schema.String),
          }),
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          NotInRepository,
          NoSuchSession,
          NoHarnessChosen,
          SessionRefused,
          PluginsNotActive,
          RuntimeUnreachable,
          RuntimeIncompatible,
          HarnessUnavailable,
          NoRuntime,
          LaunchFailed,
          UnknownAgent,
        ]),
      }),
    ),
  ),
  scoped(
    Rpc.make("Project.Open", {
      payload: {
        directory: Schema.optional(Schema.String),
        machine: Schema.optional(Schema.String),
      },
      success: Schema.Struct({ projectId: Schema.String, directory: Schema.String }),
      error: Schema.Union([Forbidden, NotInRepository, ...LINE_ERRORS]),
    }),
  ),
  scoped(
    Rpc.make("Project.Move", {
      payload: { from: Schema.String },
      success: Schema.Struct({
        projectId: Schema.String,
        directory: Schema.String,
        from: Schema.String,
        repaired: Schema.Array(Schema.String),
        manual: Schema.Array(Schema.String),
      }),
      error: Schema.Union([Forbidden, NotInRepository, MoveRefused]),
    }),
  ),
  scoped(
    Rpc.make("Project.Info", {
      success: ProjectInfoResult,
      error: Schema.Union([Forbidden, NotInRepository]),
    }),
  ),
  scoped(
    Rpc.make("Project.Search", {
      payload: ProjectSearchInput.fields,
      success: Schema.Array(Schema.String),
      error: Schema.Union([Forbidden, NotInRepository]),
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Project.Create", {
        payload: { directory: Schema.String, from: Schema.Array(Schema.String) },
        success: Schema.Struct({
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
        }),
        error: Schema.Union([Forbidden, ProjectCreateFailed]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Project.Clone", {
        payload: CloneRequest,
        success: CloneStep,
        error: Schema.Union([Forbidden, CloneFailed]),
        stream: true,
      }),
    ),
  ),
  scoped(
    Rpc.make("Daemon.Stop", {
      payload: { instance: Schema.String },
      success: Schema.Struct({ instance: Schema.String }),
      error: Schema.Union([Forbidden, WrongInstance, DaemonBusy, DaemonStopping]),
    }),
  ),
  scoped(
    Rpc.make("Daemon.Handoff", {
      payload: { instance: Schema.String, command: Schema.Array(Schema.String) },
      success: Schema.Struct({ instance: Schema.String }),
      error: Schema.Union([Forbidden, WrongInstance, DaemonBusy, DaemonStopping, LaunchFailed]),
    }),
  ),
  scoped(
    Rpc.make("Session.Ready", {
      payload: {
        id: Schema.String,
        pid: Schema.optional(Schema.Number),
        conversation: Schema.optional(Schema.Struct({ harness: Schema.String, id: Schema.String })),
      },
      success: Schema.Struct({ process: Schema.optional(Schema.Number) }),
      error: Schema.Union([Forbidden, NoSuchSession]),
    }),
  ),
  scoped(
    Rpc.make("Agents.Outdated", {
      success: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          agent: Schema.String,
          harness: Schema.String,
          integration: Schema.NullOr(Schema.String),
          working: Schema.Boolean,
          blocked: Schema.NullOr(Schema.String),
        }),
      ),
      error: Forbidden,
    }),
  ),
  scoped(
    Rpc.make("Agents.Restart", {
      payload: { ids: Schema.Array(Schema.String), after: Schema.optional(Schema.Number) },
      error: Forbidden,
    }),
  ),
  scoped(
    Rpc.make("Remote.Hello", {
      payload: { id: Schema.String, name: Schema.String, callsMe: Schema.String },
      success: Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        version: Schema.String,
        runtimes: Schema.optional(Schema.Array(RuntimeThere)),
      }),
      error: Forbidden,
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Remote.Spawn", {
        payload: {
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
        },
        success: Schema.Struct({
          session: Schema.String,
          harness: Schema.String,
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          directory: Schema.String,
          ...Routing.fields,
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          NoProject,
          NoCommit,
          PromptTooLarge,
          AllocationFailed,
          HarnessUnavailable,
          NoCallingSession,
          NoHarnessChosen,
          NoRuntime,
          SessionRefused,
          PluginsNotActive,
          UnknownAgent,
          NoSuchSession,
          RuntimeUnreachable,
          RuntimeIncompatible,
        ]),
      }),
    ),
  ),
  scoped(Rpc.make("Remote.Outbox", { success: OutboxItem, error: Forbidden, stream: true })),
  scoped(Rpc.make("Remote.Ack", { payload: { ids: Schema.Array(Schema.String) }, error: Forbidden })),
  scoped(admitted(Rpc.make("Remote.Link", RemoteLinkSpec))),
  scoped(admitted(Rpc.make("Remote.Unlink", RemoteLinkSpec))),
  scoped(
    Rpc.make("Machine.Add", {
      payload: { name: Schema.String, target: Schema.String },
      success: Schema.Struct({
        name: Schema.String,
        id: Schema.String,
        vibestd: Schema.String,
        version: Schema.String,
        notes: Schema.Array(MachineNote),
      }),
      error: Schema.Union([Forbidden, MachineFailed, MachineIncompatible, AlreadyAdded]),
    }),
  ),
  scoped(
    Rpc.make("Machine.Load", {
      payload: { machine: Schema.optional(Schema.String) },
      success: MachineLoad,
      error: Schema.Union([Forbidden, UnknownMachine, MachineUnavailable, MachineIncompatible]),
    }),
  ),
  scoped(Rpc.make("Machine.List", { success: Schema.Array(MachineInfo), error: Forbidden })),
  scoped(
    Rpc.make("Machine.Remove", {
      payload: { name: Schema.String },
      success: Schema.Struct({ notes: Schema.Array(MachineNote) }),
      error: Schema.Union([Forbidden, UnknownMachine]),
    }),
  ),
) {}

export type PayloadOf<Tag extends RpcGroup.Rpcs<typeof VibestRpcs>["_tag"]> = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof VibestRpcs>, Tag>
>
