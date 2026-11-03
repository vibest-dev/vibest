import { MessageStatus } from "@vibest/schema/model"
import { AgentRefused, PluginInfo, Routing } from "@vibest/schema/plugin"
import {
  ProjectConflict,
  ProjectDeleteInput,
  ProjectEntry,
  ProjectInfoResult,
  ProjectInvalid,
  ProjectListInput,
  ProjectReadInput,
  ProjectReadResult,
  ProjectSearchInput,
  ProjectWriteInput,
  ProjectWriteResult,
} from "@vibest/schema/project"
import { RemoveOutcome } from "@vibest/schema/remove"
import {
  AgentStatus,
  AllocationFailed,
  HARNESS_IDS,
  HarnessUnavailable,
  InboxRow,
  LaunchFailed,
  LimitReached,
  NoHarnessChosen,
  NoSuchSession,
  NotInRepository,
  NoRuntime,
  RuntimeAddress,
  RuntimeIncompatible,
  RuntimeMachine,
  RuntimeUnreachable,
  SessionBusy,
  TurnState,
} from "@vibest/schema/session"
import { Subscription } from "@vibest/schema/subscription"
// The RPC contract between vibestd and its clients (SPEC §7). Wire: one JSON-RPC 2.0 object per line
// (RpcSerialization.layerNdJsonRpc). There is no handshake: each request carries its own protocol and caller headers.
import { Context, Schema } from "effect"
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc"

import pkg from "../package.json" with { type: "json" }
import { PROTOCOL } from "./protocol.ts"

/**
 * The vibestd answering on the socket: its PID, a UUID it made at start (another vibestd, even at the same PID, has another),
 * the argv that runs its vibest, and when it started. Each optional: an older vibestd does not send them.
 */
export const DaemonIdentity = Schema.Struct({
  pid: Schema.optional(Schema.Number),
  instance: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
  startedAt: Schema.optional(Schema.Number),
})
export type DaemonIdentity = typeof DaemonIdentity.Type

/** One terminal runtime as Ping reports it (runtime-port.md §4). */
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
  /** Absent on a daemon from before this protocol. A new daemon always sends PROTOCOL. */
  protocol: Schema.optional(Schema.Number),
  version: Schema.String,
  /** Optional so a vibest can read any build's Ping far enough to compare `protocol` and say so plainly. */
  runtimes: Schema.optional(Schema.Array(RuntimeStatus)),
  /** Who answered; absent on an vibestd from before these fields. */
  ...DaemonIdentity.fields,
  /**
   * Additive features this vibestd has, by name (they do not bump PROTOCOL). A client uses one only when its flag is
   * true; absent means none. `http`: the HTTP API on vibest-http.sock. `handoff`: Daemon.Handoff (vibest update).
   */
  capabilities: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
})
export type Ping = typeof PingResult.Type

/** Package version. Informational: Ping reports it, and it is not a protocol gate. */
export const VERSION = pkg.version

export { PROTOCOL }

/**
 * A non-Ping request omitted the protocol header or sent a different one (`protocol`). Fail closed; no Hello fallback.
 * `mismatch` is @vibest/protocol `protocolMismatch`: what vibestd speaks, and what the user runs to continue.
 */
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

/** Caller headers are missing, mixed, or malformed. Never treated as the command line. */
export class InvalidCaller extends Schema.TaggedError<InvalidCaller>()("InvalidCaller", {
  method: Schema.String,
  message: Schema.String,
}) {}

/**
 * The caller's role may not call the method. Roles come from the caller's environment (a session's VIBEST_SESSION_ID)
 * plus the stored row, so this stops an agent's mistake, not a same-user process that lies about who it is.
 */
export class Forbidden extends Schema.TaggedError<Forbidden>()("Forbidden", {
  method: Schema.String,
  message: Schema.String,
}) {}

/**
 * Who this request is, resolved by middleware from headers and the database. A session never declares itself coordinator:
 * that comes from the stored agent. Not stored on the socket.
 */
export type CallerShape =
  | { readonly _tag: "Cli"; readonly repositoryRoot: string }
  | {
      readonly _tag: "Coordinator"
      readonly sessionId: string
      readonly projectId: number
      readonly repositoryRoot?: string
    }
  | { readonly _tag: "Session"; readonly sessionId: string; readonly projectId: number }

export class Caller extends Context.Service<Caller, CallerShape>()("vibest/Caller") {}

/** vibestd accepted a Daemon.Stop, or is deciding one: this change was not made. Nothing is retried for the caller. */
export class DaemonStopping extends Schema.TaggedError<DaemonStopping>()("DaemonStopping", { method: Schema.String }) {
  override get message() {
    return `vibestd is stopping to be replaced; ${this.method} was not run and nothing was recorded. Run it again once vibestd is back (vibest status)`
  }
}

/** A daemon operation or unsettled delivery that has not drained, and why. */
export const Blocker = Schema.Struct({ id: Schema.String, reason: Schema.String })
export type Blocker = typeof Blocker.Type

/** Daemon.Stop refused: daemon work did not drain. vibestd, the agents and their work keep running. */
export class DaemonBusy extends Schema.TaggedError<DaemonBusy>()("DaemonBusy", { blockers: Schema.Array(Blocker) }) {
  override get message() {
    return ["vibestd was not stopped; still in use by:", ...this.blockers.map((b) => `  ${b.id}: ${b.reason}`)].join(
      "\n",
    )
  }
}

/** Daemon.Stop named an vibestd other than the one answering (it was replaced in between). */
export class WrongInstance extends Schema.TaggedError<WrongInstance>()("WrongInstance", {
  expected: Schema.String,
  actual: Schema.NullOr(Schema.String),
}) {
  override get message() {
    return `vibestd instance ${this.actual ?? "unknown"} answers, not ${this.expected}; nothing was stopped`
  }
}

/** Every method except Ping. Fails before the handler when the protocol header is missing or wrong. */
export class ProtocolGate extends RpcMiddleware.Service<ProtocolGate>()("vibest/ProtocolGate", {
  error: ProtocolRejected,
}) {}

/** Methods that change something, counted while they run. Refused with DaemonStopping while a Daemon.Stop drains (except a hook's TurnEnd and Prompt, settlements) and after it is accepted. */
export class Admission extends RpcMiddleware.Service<Admission>()("vibest/Admission", {
  error: DaemonStopping,
}) {}

/** Scoped methods. Resolves Caller for this request only; does not annotate the socket. */
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
  projectId: Schema.Number,
  runtime: Schema.String,
  address: RuntimeAddress,
  worktree: Schema.String,
  repositoryRoot: Schema.NullOr(Schema.String),
  git: Schema.NullOr(GitInfo),
  /** Present when spawn plugins ran: which plugin decided what, and each callback's run. */
  routing: Schema.optional(Routing),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
  /** First inbox row delivered from the user or the parent session. `List` cuts it to 500 characters; `Get` keeps it. Null before that delivery. */
  task: Schema.NullOr(Schema.String),
  /** Newest message. `summary` is metadata.summary when that is a string, otherwise the first line of output. */
  latest: Schema.NullOr(
    Schema.Struct({
      status: MessageStatus,
      summary: Schema.String,
      endedAt: Schema.NullOr(Schema.Number),
    }),
  ),
})
export type SessionInfo = typeof SessionInfo.Type

/** An inbox row as clients see it (details already parsed). */
export const InboxMessage = Schema.Struct({ ...InboxRow.fields, details: Schema.Record(Schema.String, Schema.Unknown) })
export type InboxMessage = typeof InboxMessage.Type

/** One session and its latest result; null while it has none (a dropped result still shows). */
export const SessionStatusInfo = Schema.Struct({ ...SessionInfo.fields, result: Schema.NullOr(InboxMessage) })

export class VibestRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: PingResult }),
  scoped(
    admitted(
      Rpc.make("Spawn", {
        payload: {
          name: Schema.optional(Schema.String),
          prompt: Schema.String,
          /** Optional when a routing plugin picks it (plugins.md §5). */
          harness: Schema.optional(Schema.Literals(HARNESS_IDS)),
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
          /** Default general. coordinator is rejected. */
          agent: Schema.optional(Schema.String),
          /** The machine the caller names (`local`, plus the runtime's own `target`). Absent defaults to `local`. */
          machine: Schema.optional(RuntimeMachine),
          /** Share this session's worktree, in a pane split from its pane, instead of a new worktree. */
          peer: Schema.optional(Schema.String),
          /** Archive the session once a completed result reached the coordinator. */
          archive: Schema.optional(Schema.Boolean),
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
          NoHarnessChosen,
          NoRuntime,
          AgentRefused,
          NoSuchSession,
          RuntimeUnreachable,
          RuntimeIncompatible,
        ]),
      }),
    ),
  ),
  /** Loaded plugins with their state and counters since vibestd started (vibest plugins). Protocol only; no caller. */
  protocol(Rpc.make("Plugins", { success: Schema.Array(PluginInfo) })),
  /** Each loaded runtime on this machine for `vibest doctor`: its status and its own checks for `harnesses`. Protocol only; no caller. */
  protocol(
    Rpc.make("Runtimes.Doctor", {
      payload: { harnesses: Schema.Array(Schema.String) },
      success: Schema.Array(RuntimeDoctor),
    }),
  ),
  /** Logins and usage windows vibestd last read (vibest subscriptions). Protocol only; no caller. */
  protocol(Rpc.make("Subscriptions", { success: Schema.Array(Subscription) })),
  /** Put terminal labels back (the runtime started, or restarted). Protocol only; no caller. How many terminals. */
  protocol(Rpc.make("Republish", { success: Schema.Number })),
  /** `vibest` outside the repository's parent workspace, inside the runtime or not: a tab there (or a new workspace at its root) whose shell runs argv. */
  scoped(
    admitted(
      Rpc.make("Launch", {
        payload: {
          argv: Schema.Array(Schema.String),
          focus: Schema.Boolean,
          machine: Schema.optional(RuntimeMachine),
          /** The runtime the main agent's terminal opens in (`vibest --runtime`); else the choice chain's pick (the configured one included). */
          runtime: Schema.optional(Schema.String),
        },
        success: Schema.Struct({
          runtime: Schema.String,
          terminal: Schema.String,
          place: Schema.String,
          attach: Schema.NullOr(Schema.Array(Schema.String)),
        }),
        error: Schema.Union([InvalidCaller, Forbidden, NotInRepository, LaunchFailed, NoRuntime, AgentRefused]),
      }),
    ),
  ),
  /** Queue a message for the session and return; vibestd delivers it once the session is idle (failures reach its coordinator as notices). */
  scoped(
    admitted(
      Rpc.make("Send", {
        payload: { id: Schema.String, message: Schema.String },
        error: Schema.Union([Forbidden, NoSuchSession]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Interrupt", {
        payload: { id: Schema.String },
        success: Schema.Struct({ message: Schema.String }),
        error: Schema.Union([Forbidden, NoSuchSession, SessionBusy, RuntimeUnreachable, NoRuntime]),
      }),
    ),
  ),
  /** Only the session's own coordinator, or the user's command line, may remove it. */
  scoped(
    admitted(
      Rpc.make("Remove", {
        payload: { id: Schema.String, keepWorktree: Schema.optional(Schema.Boolean) },
        success: Schema.NullOr(RemoveOutcome),
        error: Schema.Union([Forbidden, NoSuchSession, SessionBusy, RuntimeUnreachable, NoRuntime]),
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
  /** The session with its latest result; never waits. */
  scoped(
    Rpc.make("Get", {
      payload: { id: Schema.String },
      success: SessionStatusInfo,
      error: Schema.Union([Forbidden, NoSuchSession]),
    }),
  ),
  /**
   * The last `lines` lines (default 30) on the session's terminal, read when asked: screen text is never pushed to an
   * agent, so a coordinator looks here itself when a result says the turn ended without a report.
   */
  scoped(
    Rpc.make("Peek", {
      payload: { id: Schema.String, lines: Schema.optional(Schema.Number) },
      success: Schema.Struct({ text: Schema.String }),
      error: Schema.Union([Forbidden, NoSuchSession, NoRuntime, RuntimeUnreachable]),
    }),
  ),
  /** A non-coordinator session: a message to that session's own coordinator. */
  scoped(
    admitted(
      Rpc.make("Report", { payload: { message: Schema.String }, error: Schema.Union([Forbidden, NoSuchSession]) }),
    ),
  ),
  /** Coordinator side (the Pi extension): this request's inbox rows, one string per batch, instead of the runtime's prompt. */
  scoped(Rpc.make("Inbox.Subscribe", { success: Schema.String, error: Schema.Union([Forbidden]), stream: true })),
  /**
   * Hook side: a harness plugin's turn-end event, verbatim JSON. vibestd reads it with the harness adapter's `turnEnd` and
   * writes the result file and the turn-end report line. Protocol only; no caller. Unknown ids, another harness than
   * the session's, and events the adapter ignores change nothing.
   */
  protocol(
    admitted(
      Rpc.make("TurnEnd", {
        payload: { sessionId: Schema.String, harness: Schema.Literals(HARNESS_IDS), event: Schema.String },
      }),
    ),
  ),
  /**
   * Hook side: a harness plugin's prompt event, verbatim JSON. vibestd reads it with the adapter's `userPrompt`, writes the
   * turn-start report line, and records the round. Protocol only; no caller. The main agent and vibest's own deliveries
   * are ignored.
   */
  protocol(
    admitted(
      Rpc.make("Prompt", {
        payload: { sessionId: Schema.String, harness: Schema.Literals(HARNESS_IDS), event: Schema.String },
      }),
    ),
  ),
  /**
   * `vibest`, before it execs: upsert the repository's coordinator row at its terminal. sessionId is that row's id
   * (VIBEST_SESSION_ID); harnessSessionId is the conversation to reopen, null with fresh or a harness switch.
   */
  scoped(
    admitted(
      Rpc.make("Project.CoordinatorSession", {
        payload: {
          harness: Schema.Literals(HARNESS_IDS),
          fresh: Schema.Boolean,
          /** The coordinator's terminal id, opaque to core, and the machine the caller names. */
          terminal: Schema.String,
          machine: Schema.optional(RuntimeMachine),
          /** The runtime the main agent runs in (`Project.StartMain`'s choice). */
          runtime: Schema.optional(Schema.String),
          /** What Project.StartMain chose, kept on the main session for `vibest ls`. */
          provider: Schema.optional(Schema.String),
          model: Schema.optional(Schema.String),
          routing: Schema.optional(Routing),
          /** The caller's own PID: it execs the harness, so this is the harness's (what StopCoordinator signals). */
          pid: Schema.optional(Schema.Number),
          /** `vibest --env`: kept on the main session, so its start after a restart runs the harness with it again. */
          env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
        },
        success: Schema.Struct({
          sessionId: Schema.String,
          harnessSessionId: Schema.NullOr(Schema.String),
          /** VIBEST_PROJECT_ID and VIBEST_RUNTIME for the main agent's environment (absent from an older vibestd). */
          projectId: Schema.optional(Schema.Number),
          runtime: Schema.optional(Schema.String),
        }),
        error: Schema.Union([InvalidCaller, Forbidden, NotInRepository, RuntimeUnreachable, RuntimeIncompatible]),
      }),
    ),
  ),
  /**
   * `vibest` before it places the main agent: scheduling and `agent.start` choose its harness, provider and model. With no
   * harness asked for, the request is the main agent's current one. Writes nothing.
   */
  scoped(
    Rpc.make("Project.StartMain", {
      payload: {
        harness: Schema.optional(Schema.Literals(HARNESS_IDS)),
        provider: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        /** `vibest --runtime <kind>`: the caller's preference; the choice plugin and §4's check decide after it. */
        runtime: Schema.optional(Schema.String),
      },
      success: Schema.Struct({
        harness: Schema.Literals(HARNESS_IDS),
        provider: Schema.optional(Schema.String),
        model: Schema.optional(Schema.String),
        /** The runtime chosen for the main agent (on its row next, by `Project.CoordinatorSession`). */
        runtime: Schema.String,
        ...Routing.fields,
      }),
      error: Schema.Union([
        InvalidCaller,
        Forbidden,
        NotInRepository,
        NoHarnessChosen,
        AgentRefused,
        HarnessUnavailable,
        NoRuntime,
      ]),
    }),
  ),
  /** A coordinator still running in another pane: display text and the opaque address to pass to StopCoordinator. */
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
      error: Schema.Union([InvalidCaller, Forbidden, NotInRepository, RuntimeUnreachable, RuntimeIncompatible]),
    }),
  ),
  /**
   * `vibest` moving the main agent to its own terminal: SIGTERM to the harness at address (opaque terminal JSON) in
   * `runtime`, its recorded PID only, then until it exited; its terminal and shell stay. stopped: gone, and what waits for
   * it is kept for the next launch. running: not stopped, nothing changed. moved: the row is no longer there.
   * unsupported: nothing signalled or changed, because vibest cannot stop it from here; reason says why.
   */
  scoped(
    admitted(
      Rpc.make("Project.StopCoordinator", {
        payload: { runtime: Schema.String, address: Schema.String },
        success: Schema.Struct({
          result: Schema.Literals(["stopped", "running", "moved", "unsupported"]),
          reason: Schema.optional(Schema.String),
        }),
        error: Schema.Union([Forbidden, NotInRepository, RuntimeUnreachable, NoRuntime, InvalidCaller]),
      }),
    ),
  ),
  /**
   * Coordinator side (the Pi extension, the Stop hook), off the turn's path: the conversation id harness made for
   * coordinator session sessionId. Protocol only; no caller. The last report for that session and harness wins; anything else is ignored.
   */
  protocol(
    admitted(
      Rpc.make("CoordinatorSessionReady", {
        payload: { sessionId: Schema.String, harness: Schema.Literals(HARNESS_IDS), harnessSessionId: Schema.String },
      }),
    ),
  ),
  scoped(Rpc.make("Project.Info", { success: ProjectInfoResult, error: Schema.Union([Forbidden, NotInRepository]) })),
  scoped(
    Rpc.make("Project.List", {
      payload: ProjectListInput.fields,
      success: Schema.Array(ProjectEntry),
      error: Schema.Union([Forbidden, NotInRepository]),
    }),
  ),
  scoped(
    Rpc.make("Project.Read", {
      payload: ProjectReadInput.fields,
      success: ProjectReadResult,
      error: Schema.Union([Forbidden, NotInRepository, ProjectInvalid]),
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
      Rpc.make("Project.Write", {
        payload: ProjectWriteInput.fields,
        success: ProjectWriteResult,
        error: Schema.Union([Forbidden, NotInRepository, ProjectConflict, ProjectInvalid]),
      }),
    ),
  ),
  scoped(
    admitted(
      Rpc.make("Project.Delete", {
        payload: ProjectDeleteInput.fields,
        error: Schema.Union([Forbidden, NotInRepository, ProjectConflict, ProjectInvalid]),
      }),
    ),
  ),
  /**
   * The user's command line only: stop this vibestd (`instance` from its Ping) once its own operations drain (agents keep running), else DaemonBusy and it
   * keeps running. A success means accepted, not exited; a client sends it once and watches Ping, whatever the reply.
   */
  scoped(
    Rpc.make("Daemon.Stop", {
      payload: { instance: Schema.String },
      success: Schema.Struct({ instance: Schema.String }),
      error: Schema.Union([Forbidden, WrongInstance, DaemonBusy, DaemonStopping]),
    }),
  ),
  /**
   * The user's command line only (`vibest update`, `handoff` capability): hand this vibestd (`instance`) over to `command`.
   * vibestd checks that `command` can open its database, drains as Daemon.Stop does, starts `command daemon --foreground
   * --import`, then closes its sockets and releases its lock for it. A failure before that leaves it serving.
   */
  scoped(
    Rpc.make("Daemon.Handoff", {
      payload: { instance: Schema.String, command: Schema.Array(Schema.String) },
      success: Schema.Struct({ instance: Schema.String }),
      error: Schema.Union([Forbidden, WrongInstance, DaemonBusy, DaemonStopping, LaunchFailed]),
    }),
  ),
  /**
   * The main agent's start after a restart (`vibest integration start <id>`, typed into its own shell at the project's
   * root): its row, from which the command builds the harness command it execs. Ready again only once that harness says so.
   */
  scoped(
    Rpc.make("Session.Start", {
      payload: { id: Schema.String },
      success: Schema.Struct({
        harness: Schema.Literals(HARNESS_IDS),
        harnessSessionId: Schema.NullOr(Schema.String),
        provider: Schema.NullOr(Schema.String),
        model: Schema.NullOr(Schema.String),
        projectId: Schema.Number,
        runtime: Schema.optional(Schema.String),
        env: Schema.Record(Schema.String, Schema.String),
      }),
      error: Schema.Union([Forbidden, NoSuchSession]),
    }),
  ),
  /**
   * The harness's integration, once at its start: the harness takes input now, and `pid` is the harness's own process (a
   * restart signals it). vibestd waits for this before it hands the harness its first turn, or a restarted one its next.
   */
  scoped(
    Rpc.make("Session.Ready", {
      payload: { id: Schema.String, pid: Schema.optional(Schema.Number) },
      error: Schema.Union([Forbidden, NoSuchSession]),
    }),
  ),
  /**
   * The user's command line only (`vibest update`): the live agents whose integration is not this vibestd's (VERSION and
   * PROTOCOL), main agents included; `working` when they are in a turn.
   */
  scoped(
    Rpc.make("Agents.Outdated", {
      success: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          agent: Schema.String,
          harness: Schema.Literals(HARNESS_IDS),
          integration: Schema.NullOr(Schema.String),
          working: Schema.Boolean,
          /** Why it cannot be restarted in place (null: it can). */
          blocked: Schema.NullOr(Schema.String),
        }),
      ),
      error: Forbidden,
    }),
  ),
  /**
   * The user's command line only (`vibest update`): restart these agents in place, in vibestd, once process `after` (that
   * `vibest update`, which may run inside one of them) has exited; returns at once. Subagents first, at most 4 at a time,
   * then main agents: SIGTERM to the harness alone, then the runtime runs it again in its terminal on the same conversation. A
   * subagent's interrupted turn gets a continue turn; a main agent that was working gets a continue notice in its inbox.
   * Outcomes go to vibestd.log, and a main agent's notice names them.
   */
  scoped(
    Rpc.make("Agents.Restart", {
      payload: { ids: Schema.Array(Schema.String), after: Schema.optional(Schema.Number) },
      error: Forbidden,
    }),
  ),
) {}
