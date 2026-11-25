import { ArchiveOutcome } from "@vibest/schema/archive"
import { MachineName, SessionId } from "@vibest/schema/id"
import {
  ListedMachine,
  MachineFailed,
  MachineIncompatible,
  MachineUnavailable,
  NoCommit,
  NoProject,
  PromptTooLarge,
  UnknownMachine,
} from "@vibest/schema/machine"
import { PluginsNotActive, SessionRefused } from "@vibest/schema/plugin"
import { NoSuchProject } from "@vibest/schema/project"
import {
  AllocationFailed,
  AmbiguousSession,
  HarnessUnavailable,
  LaunchFailed,
  NoCallingSession,
  NoHarnessChosen,
  NoRuntime,
  NoSuchSession,
  NotInRepository,
  RuntimeIncompatible,
  RuntimeUnreachable,
  SessionBusy,
  UnknownAgent,
} from "@vibest/schema/session"
import { SessionRef, Terminal } from "@vibest/schema/terminal"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, OpenApi } from "effect/http-api"

import { Forbidden, InvalidCaller } from "../errors.ts"
import { AdmissionMiddleware, CallerMiddleware, ProtocolMiddleware } from "../middleware.ts"
import {
  AttachPayload,
  AttachSuccess,
  ClaimPayload,
  ClaimSuccess,
  LaunchPayload,
  LaunchSuccess,
  SendBody,
  SpawnPayload,
  SpawnSuccess,
} from "../payloads.ts"
import { BooleanFromQuery, EdgeSpec, IntFromQuery, SessionEdge, SessionInfo, SessionStatusInfo } from "../schemas.ts"

const LINE_ERRORS = [UnknownMachine, MachineUnavailable, MachineIncompatible] as const

const PROCESS_ERRORS = [
  Forbidden,
  NoSuchSession,
  AmbiguousSession,
  SessionBusy,
  RuntimeUnreachable,
  NoRuntime,
  ...LINE_ERRORS,
] as const

export const SessionGroup = HttpApiGroup.make("server.session")
  .add(
    HttpApiEndpoint.get("session.list", "/api/session", {
      query: Schema.Struct({
        stopped: Schema.optional(BooleanFromQuery),
        all: Schema.optional(BooleanFromQuery),
      }),
      success: Schema.Struct({ sessions: Schema.Array(SessionInfo), machines: Schema.Array(ListedMachine) }),
      error: [Forbidden],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.list", summary: "List sessions" })),
  )
  .add(
    HttpApiEndpoint.get("session.get", "/api/session/:id", {
      params: Schema.Struct({ id: Schema.String }),
      query: Schema.Struct({ machine: Schema.optional(MachineName) }),
      success: SessionStatusInfo,
      error: [Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.get", summary: "Get session" })),
  )
  .add(
    HttpApiEndpoint.get("session.peek", "/api/session/:id/peek", {
      params: Schema.Struct({ id: Schema.String }),
      query: Schema.Struct({
        machine: Schema.optional(MachineName),
        lines: Schema.optional(IntFromQuery),
      }),
      success: Schema.Struct({
        text: Schema.String,
        terminal: Schema.optional(Terminal),
        view: Schema.optional(Schema.String),
      }),
      error: [Forbidden, NoSuchSession, AmbiguousSession, NoRuntime, RuntimeUnreachable, ...LINE_ERRORS],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.peek", summary: "Peek session terminal" })),
  )
  .add(
    HttpApiEndpoint.post("session.spawn", "/api/session/spawn", {
      payload: SpawnPayload,
      success: SpawnSuccess,
      error: [
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
      ],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.spawn", summary: "Spawn session" })),
  )
  .add(
    HttpApiEndpoint.post("session.launch", "/api/session/launch", {
      payload: LaunchPayload,
      success: LaunchSuccess,
      error: [
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
      ],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.launch", summary: "Launch entry session" })),
  )
  .add(
    HttpApiEndpoint.post("session.attach", "/api/session/attach", {
      payload: AttachPayload,
      success: AttachSuccess,
      error: [
        InvalidCaller,
        Forbidden,
        NotInRepository,
        NoSuchSession,
        LaunchFailed,
        UnknownAgent,
        RuntimeUnreachable,
        RuntimeIncompatible,
      ],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.attach", summary: "Attach to entry session" })),
  )
  .add(
    HttpApiEndpoint.post("session.focus", "/api/session/focus", {
      success: Schema.NullOr(
        Schema.Struct({
          sessionId: SessionId,
          place: Schema.String,
          focused: Schema.Boolean,
        }),
      ),
      error: [InvalidCaller, Forbidden, NotInRepository],
    }).annotateMerge(OpenApi.annotations({ identifier: "session.focus", summary: "Focus entry session" })),
  )
  .add(
    HttpApiEndpoint.post("session.claim", "/api/session/claim", {
      payload: ClaimPayload,
      success: ClaimSuccess,
      error: [
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
      ],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.claim", summary: "Claim entry session" })),
  )
  .add(
    HttpApiEndpoint.post("session.send", "/api/session/:id/send", {
      params: Schema.Struct({ id: Schema.String }),
      payload: SendBody,
      success: SessionRef,
      error: [Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.send", summary: "Send message to session" })),
  )
  .add(
    HttpApiEndpoint.post("session.interrupt", "/api/session/:id/interrupt", {
      params: Schema.Struct({ id: Schema.String }),
      query: Schema.Struct({ machine: Schema.optional(MachineName) }),
      success: Schema.Struct({ ...SessionRef.fields, message: Schema.String }),
      error: [...PROCESS_ERRORS],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.interrupt", summary: "Interrupt session" })),
  )
  .add(
    HttpApiEndpoint.post("session.stop", "/api/session/:id/stop", {
      params: Schema.Struct({ id: Schema.String }),
      query: Schema.Struct({ machine: Schema.optional(MachineName) }),
      success: Schema.Struct({ ...SessionRef.fields, message: Schema.String }),
      error: [...PROCESS_ERRORS],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.stop", summary: "Stop session process" })),
  )
  .add(
    HttpApiEndpoint.post("session.archive", "/api/session/:id/archive", {
      params: Schema.Struct({ id: Schema.String }),
      payload: Schema.Struct({
        machine: Schema.optional(MachineName),
        keepWorktree: Schema.optional(Schema.Boolean),
      }),
      success: Schema.NullOr(ArchiveOutcome),
      error: [...PROCESS_ERRORS],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.archive", summary: "Archive session" })),
  )
  .add(
    HttpApiEndpoint.post("session.link", "/api/session/link", {
      payload: Schema.Struct({ spec: EdgeSpec }),
      success: Schema.Struct({ edges: Schema.Array(SessionEdge) }),
      error: [Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.link", summary: "Link sessions" })),
  )
  .add(
    HttpApiEndpoint.post("session.unlink", "/api/session/unlink", {
      payload: Schema.Struct({ spec: EdgeSpec }),
      success: Schema.Struct({ edges: Schema.Array(SessionEdge) }),
      error: [Forbidden, NoSuchSession, AmbiguousSession, ...LINE_ERRORS],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.unlink", summary: "Unlink sessions" })),
  )
  .add(
    HttpApiEndpoint.post("session.seen", "/api/session/:id/seen", {
      params: Schema.Struct({ id: Schema.String }),
      payload: Schema.Struct({ finished: Schema.Number }),
      success: HttpApiSchema.NoContent,
      error: [Forbidden, NoSuchSession, RuntimeUnreachable],
    })
      .middleware(AdmissionMiddleware)
      .annotateMerge(OpenApi.annotations({ identifier: "session.seen", summary: "Mark session seen" })),
  )
  .middleware(CallerMiddleware)
  .middleware(ProtocolMiddleware)
  .annotateMerge(OpenApi.annotations({ title: "session" }))
