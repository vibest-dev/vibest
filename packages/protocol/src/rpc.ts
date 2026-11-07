import { MessageStatus } from "@vibest/schema/model"
import { AgentRefused, PluginInfo, Routing } from "@vibest/schema/plugin"
import { ProjectInfoResult, ProjectSearchInput } from "@vibest/schema/project"
import { RemoveOutcome } from "@vibest/schema/remove"
import {
  AgentStatus,
  AllocationFailed,
  AmbiguousSession,
  HARNESS_IDS,
  HarnessUnavailable,
  InboxRow,
  LaunchFailed,
  LimitReached,
  NoHarnessChosen,
  NoSuchSession,
  NotInRepository,
  ProjectMoved,
  NoRuntime,
  RuntimeAddress,
  RuntimeIncompatible,
  RuntimeMachine,
  RuntimeUnreachable,
  SessionBusy,
  TurnState,
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

export const PingResult = Schema.Struct({
  protocol: Schema.optional(Schema.Number),
  version: Schema.String,
  runtimes: Schema.optional(Schema.Array(RuntimeStatus)),
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
      readonly _tag: "Coordinator"
      readonly sessionId: string
      readonly projectId: string
      readonly repositoryRoot?: string
    }
  | { readonly _tag: "Session"; readonly sessionId: string; readonly projectId: string }

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
  harness: Schema.Literals(HARNESS_IDS),
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  status: AgentStatus,
  startedAt: Schema.NullOr(Schema.Number),
  exitedAt: Schema.NullOr(Schema.Number),
  turnState: TurnState,
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
})
export type SessionInfo = typeof SessionInfo.Type

export const InboxMessage = Schema.Struct({ ...InboxRow.fields, details: Schema.Record(Schema.String, Schema.Unknown) })
export type InboxMessage = typeof InboxMessage.Type

export const SessionStatusInfo = Schema.Struct({ ...SessionInfo.fields, result: Schema.NullOr(InboxMessage) })

export const HarnessModel = Schema.Struct({
  provider: Schema.NullOr(Schema.String),
  model: Schema.String,
  name: Schema.String,
  default: Schema.Boolean,
})

export const HarnessChoice = Schema.Struct({
  harness: Schema.Literals(HARNESS_IDS),
  problem: Schema.NullOr(Schema.String),
  models: Schema.Array(HarnessModel),
})
export type HarnessChoice = typeof HarnessChoice.Type

export const ProjectActivity = Schema.Literals(["blocked", "done", "working", "idle"])
export type ProjectActivity = typeof ProjectActivity.Type

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
  turn: Schema.NullOr(Schema.Number),
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
          harness: Schema.optional(Schema.Literals(HARNESS_IDS)),
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          agent: Schema.optional(Schema.String),
          machine: Schema.optional(RuntimeMachine),
          peer: Schema.optional(Schema.String),
          archive: Schema.optional(Schema.Boolean),
          request: Schema.optional(Schema.String),
        },
        success: Schema.Struct({
          id: Schema.String,
          harness: Schema.Literals(HARNESS_IDS),
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          ...Routing.fields,
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          LimitReached,
          AllocationFailed,
          HarnessUnavailable,
          NotInRepository,
          ProjectMoved,
          NoHarnessChosen,
          NoRuntime,
          AgentRefused,
          NoSuchSession,
          AmbiguousSession,
          RuntimeUnreachable,
          RuntimeIncompatible,
        ]),
      }),
    ),
  ),
  protocol(Rpc.make("Plugins", { success: Schema.Array(PluginInfo) })),
  protocol(Rpc.make("Harnesses.List", { success: Schema.Array(HarnessChoice) })),
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
          focus: Schema.Boolean,
          machine: Schema.optional(RuntimeMachine),
          runtime: Schema.optional(Schema.String),
        },
        success: Schema.Struct({
          runtime: Schema.String,
          terminal: Schema.String,
          place: Schema.String,
          attach: Schema.NullOr(Schema.Array(Schema.String)),
        }),
        error: Schema.Union([
          InvalidCaller,
          Forbidden,
          NotInRepository,
          ProjectMoved,
          LaunchFailed,
          NoRuntime,
          AgentRefused,
        ]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Send", {
        payload: { id: Schema.String, message: Schema.String, request: Schema.optional(Schema.String) },
        success: Schema.Struct({ id: Schema.String }),
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Interrupt", {
        payload: { id: Schema.String },
        success: Schema.Struct({ id: Schema.String, message: Schema.String }),
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, SessionBusy, RuntimeUnreachable, NoRuntime]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Remove", {
        payload: { id: Schema.String, keepWorktree: Schema.optional(Schema.Boolean) },
        success: Schema.NullOr(RemoveOutcome),
        error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, SessionBusy, RuntimeUnreachable, NoRuntime]),
      }),
    ),
  ),
  scoped(
    Rpc.make("List", {
      payload: { stopped: Schema.optional(Schema.Boolean), all: Schema.optional(Schema.Boolean) },
      success: Schema.Array(SessionInfo),
      error: Schema.Union([Forbidden]),
    }),
  ),
  scoped(
    Rpc.make("Get", {
      payload: { id: Schema.String },
      success: SessionStatusInfo,
      error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession]),
    }),
  ),
  scoped(
    Rpc.make("Peek", {
      payload: { id: Schema.String, lines: Schema.optional(Schema.Number) },
      success: Schema.Struct({ text: Schema.String }),
      error: Schema.Union([Forbidden, NoSuchSession, AmbiguousSession, NoRuntime, RuntimeUnreachable]),
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Report", { payload: { message: Schema.String }, error: Schema.Union([Forbidden, NoSuchSession]) }),
    ),
  ),
  scoped(Rpc.make("Inbox.Subscribe", { success: Schema.String, error: Schema.Union([Forbidden]), stream: true })),
  scoped(Rpc.make("Watch", { success: WatchEvent, error: Schema.Union([Forbidden, WatchLagged]), stream: true })),
  scoped(
    admitted(
      Rpc.make("Session.Seen", {
        payload: { id: Schema.String, turn: Schema.Number },
        error: Schema.Union([Forbidden, NoSuchSession, RuntimeUnreachable]),
      }),
    ),
  ),
  protocol(
    admitted(
      Rpc.make("TurnEnd", {
        payload: { sessionId: Schema.String, harness: Schema.Literals(HARNESS_IDS), event: Schema.String },
      }),
    ),
  ),
  protocol(
    admitted(
      Rpc.make("Prompt", {
        payload: { sessionId: Schema.String, harness: Schema.Literals(HARNESS_IDS), event: Schema.String },
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Project.CoordinatorSession", {
        payload: {
          harness: Schema.Literals(HARNESS_IDS),
          fresh: Schema.Boolean,
          terminal: Schema.String,
          machine: Schema.optional(RuntimeMachine),
          runtime: Schema.optional(Schema.String),
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          routing: Schema.optional(Routing),
          pid: Schema.optional(Schema.Number),
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        },
        success: Schema.Struct({
          sessionId: Schema.String,
          harnessSessionId: Schema.NullOr(Schema.String),
          projectId: Schema.String,
          runtime: Schema.optional(Schema.String),
        }),
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
  ),
  scoped(
    Rpc.make("Project.StartMain", {
      payload: {
        harness: Schema.optional(Schema.Literals(HARNESS_IDS)),
        provider: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        runtime: Schema.optional(Schema.String),
      },
      success: Schema.Struct({
        harness: Schema.Literals(HARNESS_IDS),
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
    Rpc.make("Project.RunningCoordinator", {
      payload: { terminal: Schema.String, machine: Schema.optional(RuntimeMachine) },
      success: Schema.NullOr(
        Schema.Struct({
          harness: Schema.Literals(HARNESS_IDS),
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
      Rpc.make("Project.StopCoordinator", {
        payload: { runtime: Schema.String, address: Schema.String },
        success: Schema.Struct({
          result: Schema.Literals(["stopped", "running", "moved", "unsupported"]),
          reason: Schema.optional(Schema.String),
        }),
        error: Schema.Union([Forbidden, NotInRepository, ProjectMoved, RuntimeUnreachable, NoRuntime, InvalidCaller]),
      }),
    ),
  ),
  protocol(
    admitted(
      Rpc.make("CoordinatorSessionReady", {
        payload: { sessionId: Schema.String, harness: Schema.Literals(HARNESS_IDS), harnessSessionId: Schema.String },
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
    Rpc.make("Session.Start", {
      payload: { id: Schema.String },
      success: Schema.Struct({
        harness: Schema.Literals(HARNESS_IDS),
        harnessSessionId: Schema.NullOr(Schema.String),
        provider: Schema.NullOr(Schema.String),
        model: Schema.NullOr(Schema.String),
        projectId: Schema.String,
        runtime: Schema.optional(Schema.String),
        env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
      }),
      error: Schema.Union([Forbidden, NoSuchSession]),
    }),
  ),
  scoped(
    Rpc.make("Session.Ready", {
      payload: { id: Schema.String, pid: Schema.optional(Schema.Number) },
      error: Schema.Union([Forbidden, NoSuchSession]),
    }),
  ),
  scoped(
    Rpc.make("Agents.Outdated", {
      success: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          agent: Schema.String,
          harness: Schema.Literals(HARNESS_IDS),
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
) {}

export const ACCESS = {
  Ping: "open",
  Plugins: "open",
  "Harnesses.List": "open",
  "Runtimes.Doctor": "open",
  Subscriptions: "open",
  Republish: "open",
  TurnEnd: "open",
  Prompt: "open",
  CoordinatorSessionReady: "open",
  Report: "session",
  Spawn: "agent",
  Launch: "agent",
  List: "agent",
  Get: "agent",
  "Inbox.Subscribe": "coordinator",
  Watch: "cli",
  "Session.Seen": "cli",
  "Project.Open": "cli",
  "Project.CoordinatorSession": "agent",
  "Project.StartMain": "agent",
  "Project.RunningCoordinator": "agent",
  "Project.StopCoordinator": "agent",
  "Project.Info": "agent",
  "Project.Search": "agent",
  Send: "owner",
  Interrupt: "owner",
  Peek: "owner",
  Remove: "owner",
  "Daemon.Stop": "cli",
  "Daemon.Handoff": "cli",
  "Session.Start": "self",
  "Session.Ready": "self",
  "Agents.Outdated": "cli",
  "Agents.Restart": "cli",
} as const satisfies Record<
  RpcGroup.Rpcs<typeof VibestRpcs>["_tag"],
  "open" | "session" | "agent" | "coordinator" | "owner" | "cli" | "self"
>

export const CAPABILITIES = {
  http: true,
  handoff: true,
  requests: true,
  watch: true,
  projects: true,
  harnesses: true,
} as const
