import { ArchiveOutcome } from "@vibest/schema/archive"
import { MachineName, ProjectId, SessionId } from "@vibest/schema/id"
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
  UnknownMachine,
} from "@vibest/schema/machine"
import { SessionRefused, PluginInfo, PluginsNotActive } from "@vibest/schema/plugin"
import {
  NoSuchProject,
  CloneFailed,
  CloneRequest,
  CloneStep,
  ProjectCreateFailed,
  ProjectInfoResult,
  ProjectSearchInput,
} from "@vibest/schema/project"
import {
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
} from "@vibest/schema/session"
import { Subscription } from "@vibest/schema/subscription"
import { SessionRef, Terminal } from "@vibest/schema/terminal"
import { WorktreeList } from "@vibest/schema/worktree"
import { Schema } from "effect"
import { Rpc, RpcGroup, type RpcMiddleware } from "effect/rpc"

import {
  AttachPayload,
  AttachSuccess,
  ClaimPayload,
  ClaimSuccess,
  LaunchPayload,
  LaunchSuccess,
  MachineAddSuccess,
  ProjectCreateSuccess,
  RemoteHelloSuccess,
  RemoteSpawnPayload,
  RemoteSpawnSuccess,
  SendPayload,
  SpawnPayload,
  SpawnSuccess,
} from "./rpc-payloads.ts"
import {
  Admission,
  CallerGate,
  DaemonBusy,
  DaemonStopping,
  EdgeSpec,
  Forbidden,
  InvalidCaller,
  PingResult,
  ProtocolGate,
  RuntimeDoctor,
  SessionEdge,
  SessionInfo,
  SessionStatusInfo,
  StoredEvent,
  WatchEvent,
  WatchLagged,
  WrongInstance,
} from "./rpc-schemas.ts"

export * from "./rpc-schemas.ts"

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

export class VibestRpcs extends RpcGroup.make(
  Rpc.make("Ping", { success: PingResult }),
  scoped(
    admitted(
      Rpc.make("Spawn", {
        payload: SpawnPayload,
        success: SpawnSuccess,
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
      payload: { provider: Schema.optional(Schema.String), machine: Schema.optional(MachineName) },
      success: Schema.Array(HarnessChoice),
      error: Schema.Union([Forbidden, ...LINE_ERRORS]),
    }),
  ),
  protocol(
    Rpc.make("Agents.List", {
      payload: { machine: Schema.optional(MachineName) },
      success: AgentListing,
      error: Schema.Union([Forbidden, ...LINE_ERRORS]),
    }),
  ),
  protocol(
    Rpc.make("Worktree.List", {
      payload: { project: Schema.optional(Schema.String), machine: Schema.optional(MachineName) },
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
        payload: LaunchPayload,
        success: LaunchSuccess,
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
        payload: SendPayload,
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
      success: StoredEvent,
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
      payload: AttachPayload,
      success: AttachSuccess,
      error: Schema.Union([
        InvalidCaller,
        Forbidden,
        NotInRepository,
        NoSuchSession,
        LaunchFailed,
        UnknownAgent,
        RuntimeUnreachable,
        RuntimeIncompatible,
      ]),
    }),
  ),
  scoped(
    Rpc.make("Session.Focus", {
      success: Schema.NullOr(
        Schema.Struct({
          sessionId: SessionId,
          place: Schema.String,
          focused: Schema.Boolean,
        }),
      ),
      error: Schema.Union([InvalidCaller, Forbidden, NotInRepository]),
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Session.Claim", {
        payload: ClaimPayload,
        success: ClaimSuccess,
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
        machine: Schema.optional(MachineName),
      },
      success: Schema.Struct({ projectId: ProjectId, directory: Schema.String }),
      error: Schema.Union([Forbidden, NotInRepository, ...LINE_ERRORS]),
    }),
  ),
  scoped(
    Rpc.make("Project.Move", {
      payload: { from: Schema.String },
      success: Schema.Struct({
        projectId: ProjectId,
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
        success: ProjectCreateSuccess,
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
        id: SessionId,
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
      success: RemoteHelloSuccess,
      error: Forbidden,
    }),
  ),
  scoped(
    admitted(
      Rpc.make("Remote.Spawn", {
        payload: RemoteSpawnPayload,
        success: RemoteSpawnSuccess,
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
      payload: { name: MachineName, target: Schema.String },
      success: MachineAddSuccess,
      error: Schema.Union([Forbidden, MachineFailed, MachineIncompatible, AlreadyAdded]),
    }),
  ),
  scoped(
    Rpc.make("Machine.Load", {
      payload: { machine: Schema.optional(MachineName) },
      success: MachineLoad,
      error: Schema.Union([Forbidden, UnknownMachine, MachineUnavailable, MachineIncompatible]),
    }),
  ),
  scoped(Rpc.make("Machine.List", { success: Schema.Array(MachineInfo), error: Forbidden })),
  scoped(
    Rpc.make("Machine.Remove", {
      payload: { name: MachineName },
      success: Schema.Struct({ notes: Schema.Array(MachineNote) }),
      error: Schema.Union([Forbidden, UnknownMachine]),
    }),
  ),
) {}

export type PayloadOf<Tag extends RpcGroup.Rpcs<typeof VibestRpcs>["_tag"]> = Rpc.Payload<
  Rpc.ExtractTag<RpcGroup.Rpcs<typeof VibestRpcs>, Tag>
>
