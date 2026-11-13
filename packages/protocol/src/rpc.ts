import {
  AlreadyAdded,
  ListedMachine,
  MachineFailed,
  MachineIncompatible,
  MachineInfo,
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
import { AgentRefused, PluginInfo, Routing } from "@vibest/schema/plugin"
import { ProjectActivity, ProjectCreateFailed, ProjectInfoResult, ProjectSearchInput } from "@vibest/schema/project"
import { RemoveOutcome } from "@vibest/schema/remove"
import {
  AgentStatus,
  AllocationFailed,
  AmbiguousSession,
  HarnessChoice,
  HarnessUnavailable,
  LaunchFailed,
  LimitReached,
  NoCallingSession,
  NoHarnessChosen,
  NoSuchSession,
  NotInRepository,
  ProjectMoved,
  NoRuntime,
  RuntimeAddress,
  RuntimeIncompatible,
  RuntimeUnreachable,
  SessionBusy,
  UnknownAgent,
  ExecutionState,
} from "@vibest/schema/session"
import { Subscription } from "@vibest/schema/subscription"
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

import pkg from "../package.json" with { type: "json" }
import { PROTOCOL } from "./protocol.ts"

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

export const PingResult = Schema.Struct({
  protocol: Schema.optional(Schema.Number),
  version: Schema.String,
  runtimes: Schema.optional(Schema.Array(RuntimeStatus)),
  update: Schema.optional(UpdateStatus),
  ...DaemonIdentity.fields,
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})
export type Ping = typeof PingResult.Type

export const VERSION = pkg.version

export { PROTOCOL }

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

export type CallerShape =
  | { readonly _tag: "Cli"; readonly repositoryRoot: string }
  | {
      readonly _tag: "Session"
      readonly sessionId: string
      readonly projectId: string
      readonly repositoryRoot?: string
    }
  | {
      readonly _tag: "Peer"
      readonly peerId: string
      readonly projectId?: string
      readonly session?: string
    }

export class Caller extends Context.Service<Caller, CallerShape>()("vibest/Caller") {}

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
  error: Schema.Union([InvalidCaller, NoSuchSession]),
}) {}

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
  address: RuntimeAddress,
  worktree: Schema.String,
  repositoryRoot: Schema.NullOr(Schema.String),
  git: Schema.NullOr(GitInfo),
  routing: Schema.optional(Routing),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
  task: Schema.NullOr(Schema.String),
  latest: Schema.NullOr(
    Schema.Struct({
      status: MessageStatus,
      summary: Schema.String,
      endedAt: Schema.NullOr(Schema.Number),
    }),
  ),
  machine: Schema.optional(Schema.String),
  view: Schema.optional(Schema.String),
})
export type SessionInfo = typeof SessionInfo.Type

const LINE_ERRORS = [UnknownMachine, MachineUnavailable, MachineIncompatible] as const

export const SessionReply = Schema.Struct({
  execution: Schema.Number,
  status: Schema.String,
  text: Schema.NullOr(Schema.String),
  failure: Schema.NullOr(Schema.String),
  endedAt: Schema.Number,
})

export const SessionStatusInfo = Schema.Struct({
  ...SessionInfo.fields,
  reply: Schema.optional(Schema.NullOr(SessionReply)),
})

export const ProjectRow = Schema.Struct({
  id: Schema.String,
  directory: Schema.NullOr(Schema.String),
  entrySessionId: Schema.NullOr(Schema.String),
  activity: ProjectActivity,
})
export type ProjectRow = typeof ProjectRow.Type

export const WatchSession = Schema.Struct({
  ...SessionInfo.fields,
  parentId: Schema.NullOr(Schema.String),
  finished: Schema.NullOr(Schema.Number),
})
export type WatchSession = typeof WatchSession.Type

export const WatchEvent = Schema.Union([
  Schema.TaggedStruct("Snapshot", { projects: Schema.Array(ProjectRow), sessions: Schema.Array(WatchSession) }),
  Schema.TaggedStruct("Project", { project: ProjectRow }),
  Schema.TaggedStruct("Session", { session: WatchSession }),
  Schema.TaggedStruct("SessionEnded", { id: Schema.String, projectId: Schema.String }),
])
export type WatchEvent = typeof WatchEvent.Type

export class WatchLagged extends Schema.TaggedError<WatchLagged>()("WatchLagged", { message: Schema.String }) {}

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
          archive: Schema.optional(Schema.Boolean),
          runtime: Schema.optional(Schema.String),
          request: Schema.optional(Schema.String),
          machine: Schema.optional(Schema.String),
        },
        success: Schema.Struct({
          id: Schema.String,
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
          LimitReached,
          AllocationFailed,
          HarnessUnavailable,
          NotInRepository,
          ProjectMoved,
          NoCallingSession,
          NoHarnessChosen,
          NoRuntime,
          AgentRefused,
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
    Rpc.make("Harnesses.List", {
      payload: { provider: Schema.optional(Schema.String), machine: Schema.optional(Schema.String) },
      success: Schema.Array(HarnessChoice),
      error: Schema.Union([Forbidden, ...LINE_ERRORS]),
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
          argv: Schema.Array(Schema.String),
          agent: Schema.String,
          focus: Schema.Boolean,
          callerEnv: Schema.Record(Schema.String, Schema.String),
          runtimeSession: Schema.optional(Schema.String),
          runtime: Schema.optional(Schema.String),
        },
        success: Schema.Struct({
          runtime: Schema.String,
          terminal: Schema.String,
          place: Schema.String,
          attach: Schema.NullOr(Schema.Array(Schema.String)),
          routing: Schema.optional(Schema.String),
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          NotInRepository,
          ProjectMoved,
          LaunchFailed,
          NoRuntime,
          AgentRefused,
          UnknownAgent,
        ]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Send", {
        payload: { id: Schema.String, message: Schema.String, request: Schema.optional(Schema.String) },
        success: Schema.Struct({ id: Schema.String }),
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Interrupt", {
        payload: { id: Schema.String },
        success: Schema.Struct({ id: Schema.String, message: Schema.String }),
        error: Schema.Union([
          Forbidden,
          NoSuchSession,
          AmbiguousSession,
          SessionBusy,
          RuntimeUnreachable,
          NoRuntime,
          ...LINE_ERRORS,
        ]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Remove", {
        payload: { id: Schema.String, keepWorktree: Schema.optional(Schema.Boolean) },
        success: Schema.NullOr(RemoveOutcome),
        error: Schema.Union([
          Forbidden,
          NoSuchSession,
          AmbiguousSession,
          SessionBusy,
          RuntimeUnreachable,
          NoRuntime,
          ...LINE_ERRORS,
        ]),
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
    Rpc.make("Get", {
      payload: { id: Schema.String },
      success: SessionStatusInfo,
      error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS]),
    }),
  ),
  scoped(
    Rpc.make("Peek", {
      payload: { id: Schema.String, lines: Schema.optional(Schema.Number) },
      success: Schema.Struct({
        text: Schema.String,
        terminal: Schema.optional(Schema.String),
        view: Schema.optional(Schema.String),
      }),
      error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, NoRuntime, RuntimeUnreachable, ...LINE_ERRORS]),
    }),
  ),
  scoped(Rpc.make("Inbox.Subscribe", { success: Schema.Null, error: Schema.Union([Forbidden]), stream: true })),
  scoped(
    Rpc.make("Inbox.Take", {
      success: Schema.NullOr(
        Schema.Struct({
          execution: Schema.Number,
          ids: Schema.Array(Schema.Number),
          line: Schema.String,
          text: Schema.String,
        }),
      ),
      error: Schema.Union([Forbidden]),
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
    admitted(
      Rpc.make("Project.EntrySession", {
        payload: {
          harness: Schema.String,
          agent: Schema.String,
          fresh: Schema.Boolean,
          terminal: Schema.String,
          runtime: Schema.optional(Schema.String),
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          routing: Schema.optional(Routing),
          pid: Schema.optional(Schema.Number),
        },
        success: Schema.Struct({
          sessionId: Schema.String,
          harnessSessionId: Schema.NullOr(Schema.String),
          projectId: Schema.String,
          runtime: Schema.optional(Schema.String),
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
          ProjectMoved,
          RuntimeUnreachable,
          RuntimeIncompatible,
          HarnessUnavailable,
          LaunchFailed,
          UnknownAgent,
        ]),
      }),
    ),
  ),
  scoped(
    Rpc.make("Project.StartEntry", {
      payload: {
        harness: Schema.optional(Schema.String),
        agent: Schema.String,
        provider: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        runtime: Schema.optional(Schema.String),
      },
      success: Schema.Struct({
        harness: Schema.String,
        provider: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        runtime: Schema.String,
        ...Routing.fields,
      }),
      error: Schema.Union([
        InvalidCaller,
        Forbidden,
        NotInRepository,
        ProjectMoved,
        NoHarnessChosen,
        AgentRefused,
        HarnessUnavailable,
        NoRuntime,
        LaunchFailed,
        UnknownAgent,
      ]),
    }),
  ),
  scoped(
    Rpc.make("Project.Open", {
      payload: { move: Schema.optional(Schema.Boolean) },
      success: Schema.Struct({
        projectId: Schema.String,
        directory: Schema.String,
        moved: Schema.optional(
          Schema.Struct({
            from: Schema.String,
            repaired: Schema.Array(Schema.String),
            manual: Schema.Array(Schema.String),
          }),
        ),
        candidates: Schema.optional(Schema.Array(Schema.String)),
      }),
      error: Schema.Union([Forbidden, NotInRepository, ProjectMoved]),
    }),
  ),
  scoped(
    Rpc.make("Project.EntryPlace", {
      payload: {
        callerEnv: Schema.Record(Schema.String, Schema.String),
        runtime: Schema.optional(Schema.String),
      },
      success: Schema.Struct({
        directory: Schema.String,
        place: Schema.Union([
          Schema.Struct({
            in: Schema.Literals(["terminal"]),
            runtime: Schema.String,
            terminal: Schema.String,
          }),
          Schema.Struct({
            in: Schema.Literals(["launch"]),
            runtime: Schema.String,
          }),
        ]),
      }),
      error: Schema.Union([InvalidCaller, Forbidden, NotInRepository, ProjectMoved, LaunchFailed]),
    }),
  ),
  scoped(
    Rpc.make("Project.FocusEntry", {
      payload: {},
      success: Schema.NullOr(Schema.Struct({ place: Schema.String, focused: Schema.Boolean })),
      error: Schema.Union([Forbidden, NotInRepository, ProjectMoved]),
    }),
  ),
  scoped(
    Rpc.make("Project.RunningEntry", {
      payload: { terminal: Schema.String },
      success: Schema.NullOr(
        Schema.Struct({
          harness: Schema.String,
          place: Schema.String,
          runtime: Schema.String,
          address: Schema.String,
        }),
      ),
      error: Schema.Union([
        InvalidCaller,
        Forbidden,
        NotInRepository,
        ProjectMoved,
        RuntimeUnreachable,
        RuntimeIncompatible,
      ]),
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Project.StopEntry", {
        payload: { runtime: Schema.String, address: Schema.String },
        success: Schema.Struct({
          result: Schema.Literals(["stopped", "running", "moved", "unsupported"]),
          reason: Schema.optional(Schema.String),
        }),
        error: Schema.Union([Forbidden, NotInRepository, ProjectMoved, RuntimeUnreachable, NoRuntime, InvalidCaller]),
      }),
    ),
  ),
  scoped(
    Rpc.make("Project.Info", {
      success: ProjectInfoResult,
      error: Schema.Union([Forbidden, NotInRepository, ProjectMoved]),
    }),
  ),
  scoped(
    Rpc.make("Project.Search", {
      payload: ProjectSearchInput.fields,
      success: Schema.Array(Schema.String),
      error: Schema.Union([Forbidden, NotInRepository, ProjectMoved]),
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
    Rpc.make("Peer.Hello", {
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
      Rpc.make("Peer.Spawn", {
        payload: {
          repository: Schema.String,
          identity: Schema.optional(Schema.String),
          commit: Schema.String,
          agent: Schema.String,
          prompt: Schema.String,
          harness: Schema.optional(Schema.String),
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          title: Schema.optional(Schema.String),
          runtime: Schema.optional(Schema.String),
          request: Schema.String,
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
          LimitReached,
          AllocationFailed,
          HarnessUnavailable,
          NoCallingSession,
          NoHarnessChosen,
          NoRuntime,
          AgentRefused,
          UnknownAgent,
          NoSuchSession,
          RuntimeUnreachable,
          RuntimeIncompatible,
        ]),
      }),
    ),
  ),
  scoped(Rpc.make("Peer.Outbox", { success: OutboxItem, error: Forbidden, stream: true })),
  scoped(Rpc.make("Peer.Ack", { payload: { ids: Schema.Array(Schema.String) }, error: Forbidden })),
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
  scoped(Rpc.make("Machine.List", { success: Schema.Array(MachineInfo), error: Forbidden })),
  scoped(
    Rpc.make("Machine.Remove", {
      payload: { name: Schema.String },
      success: Schema.Struct({ notes: Schema.Array(MachineNote) }),
      error: Schema.Union([Forbidden, UnknownMachine]),
    }),
  ),
) {}

type Access = "open" | "session" | "agent" | "owner" | "cli" | "self" | "peer"

export const ACCESS = {
  Ping: ["open", "peer"],
  Plugins: "open",
  "Harnesses.List": ["open", "peer"],
  "Integration.Guard": "open",
  "Runtimes.Doctor": "open",
  Subscriptions: "open",
  Republish: "open",
  ExecutionEnd: "open",
  Prompt: "open",
  Spawn: "agent",
  Launch: "cli",
  List: ["agent", "peer"],
  Get: ["agent", "peer"],
  "Inbox.Subscribe": "session",
  "Inbox.Take": "session",
  Watch: "cli",
  "Session.Seen": "cli",
  "Project.Open": "cli",
  "Project.EntryPlace": "cli",
  "Project.EntrySession": "cli",
  "Project.StartEntry": "cli",
  "Project.FocusEntry": "cli",
  "Project.RunningEntry": "agent",
  "Project.StopEntry": "cli",
  "Project.Create": "cli",
  "Project.Info": "agent",
  "Project.Search": "agent",
  Send: ["owner", "session", "peer"],
  Interrupt: ["owner", "peer"],
  Peek: ["owner", "peer"],
  Remove: ["owner", "peer"],
  "Daemon.Stop": "cli",
  "Daemon.Handoff": "cli",
  "Session.Ready": "self",
  "Agents.Outdated": "cli",
  "Agents.Restart": "cli",
  "Peer.Hello": "peer",
  "Peer.Spawn": "peer",
  "Peer.Outbox": "peer",
  "Peer.Ack": "peer",
  "Machine.Add": "cli",
  "Machine.List": "cli",
  "Machine.Remove": "cli",
} as const satisfies Record<RpcGroup.Rpcs<typeof VibestRpcs>["_tag"], Access | readonly Access[]>

export type PayloadOf<Tag extends RpcGroup.Rpcs<typeof VibestRpcs>["_tag"]> = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof VibestRpcs>, Tag>
>

export const PEER_CALLS: ReadonlySet<string> = new Set(
  Object.entries(ACCESS)
    .filter(([, access]) => ([] as ReadonlyArray<string>).concat(access).includes("peer"))
    .map(([method]) => method),
)

export const FORWARDED_CALLS: ReadonlySet<string> = new Set(
  [...PEER_CALLS].filter((method) => method !== "Ping" && method !== "Harnesses.List" && !method.startsWith("Peer.")),
)

export const CAPABILITIES = {
  http: true,
  handoff: true,
  requests: true,
  watch: true,
  projects: true,
  spawnRuntime: true,
} as const
