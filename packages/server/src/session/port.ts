import type { AgentResponse } from "@vibest/contract";
import { Context, Effect, Layer, Stream } from "effect";

import { AgentUnavailable, SessionOpenFailed, SessionResumeFailed } from "../errors";
import {
  type AgentOperationError,
  type AgentRequestUnavailable,
  type CreateSessionError,
  HarnessAgentSessionService,
  type PromptReceipt,
  type ResumeSessionError,
  type SessionClosed,
  type SessionEnvelopeBody,
  type SessionNotFound as HarnessSessionNotFound,
  type TurnAlreadyRunning,
  type UserInput,
} from "../harness";
import type { HarnessAgentId } from "../types";

export type HarnessCreateError = AgentUnavailable | SessionOpenFailed;
export type HarnessResumeError = AgentUnavailable | SessionResumeFailed;
export type HarnessEventsError = HarnessSessionNotFound;
export type HarnessPromptError =
  | HarnessSessionNotFound
  | SessionClosed
  | TurnAlreadyRunning
  | AgentOperationError;
export type HarnessInterruptError = HarnessSessionNotFound | SessionClosed | AgentOperationError;
export type HarnessSetConfigError = HarnessSessionNotFound | SessionClosed | AgentOperationError;
export type HarnessRespondError =
  | HarnessSessionNotFound
  | AgentRequestUnavailable
  | AgentOperationError;

/**
 * The single seam onto the HarnessAgent we depend on. `SessionService` talks
 * only to this port, never to `@vibest/harness` directly, so the orchestration
 * (projectId resolution, id translation, metadata, runtime fan-out) can be
 * built and tested against a fake. The port speaks the agent-native session id
 * and a resolved `workspacePath` only — it never sees a projectId or a server
 * sessionId. Create/resume errors are mapped to server errors here; the
 * active-instance ops pass the HarnessAgent's own errors through.
 */
export class HarnessAgentSessionPort extends Context.Service<
  HarnessAgentSessionPort,
  {
    /** Open a fresh native session; returns the agent-native session id. */
    readonly create: (
      harnessAgentId: HarnessAgentId,
      workspacePath: string,
      config?: { readonly model?: string; readonly permissionMode?: string },
    ) => Effect.Effect<string, HarnessCreateError>;
    /** Ensure a native session is active again from its stored native id. */
    readonly resume: (
      harnessAgentId: HarnessAgentId,
      harnessSessionId: string,
      workspacePath: string,
    ) => Effect.Effect<void, HarnessResumeError>;
    /** Close a native session; idempotent no-op if it is not active. */
    readonly close: (harnessSessionId: string) => Effect.Effect<void>;
    /** The raw per-session body stream, drained by a SessionRuntime. */
    readonly events: (
      harnessSessionId: string,
    ) => Effect.Effect<Stream.Stream<SessionEnvelopeBody, AgentOperationError>, HarnessEventsError>;
    readonly prompt: (
      harnessSessionId: string,
      input: UserInput,
    ) => Effect.Effect<PromptReceipt, HarnessPromptError>;
    readonly interrupt: (harnessSessionId: string) => Effect.Effect<void, HarnessInterruptError>;
    // Session-scoped config setters; values use the harness's outward vocabulary.
    readonly setModel: (
      harnessSessionId: string,
      model: string,
    ) => Effect.Effect<void, HarnessSetConfigError>;
    readonly setPermissionMode: (
      harnessSessionId: string,
      permissionMode: string,
    ) => Effect.Effect<void, HarnessSetConfigError>;
    readonly respondToAgentRequest: (
      harnessSessionId: string,
      requestId: string,
      response: AgentResponse,
    ) => Effect.Effect<void, HarnessRespondError>;
  }
>()("HarnessAgentSessionPort") {}

const mapCreateError =
  (harnessAgentId: HarnessAgentId) =>
  (error: CreateSessionError): HarnessCreateError =>
    error._tag === "AgentUnavailable"
      ? new AgentUnavailable({ harnessAgentId, reason: error.reason })
      : new SessionOpenFailed({ harnessAgentId, reason: error.message });

const mapResumeError =
  (harnessAgentId: HarnessAgentId, harnessSessionId: string) =>
  (error: ResumeSessionError): HarnessResumeError =>
    error._tag === "AgentUnavailable"
      ? new AgentUnavailable({ harnessAgentId, reason: error.reason })
      : new SessionResumeFailed({ harnessSessionId, reason: error.message });

/** The real port: adapts {@link HarnessAgentSessionService} and maps its errors. */
export const HarnessAgentSessionPortLayer: Layer.Layer<
  HarnessAgentSessionPort,
  never,
  HarnessAgentSessionService
> = Layer.effect(
  HarnessAgentSessionPort,
  Effect.gen(function* () {
    const harness = yield* HarnessAgentSessionService;
    return {
      create: (harnessAgentId, workspacePath, config) =>
        harness
          .create(harnessAgentId, {
            workspacePath,
            ...(config?.model !== undefined ? { model: config.model } : {}),
            ...(config?.permissionMode !== undefined
              ? { permissionMode: config.permissionMode }
              : {}),
          })
          .pipe(
            Effect.map((result) => result.sessionId),
            Effect.mapError(mapCreateError(harnessAgentId)),
          ),
      resume: (harnessAgentId, harnessSessionId, workspacePath) =>
        harness
          .resume({ sessionId: harnessSessionId, harnessAgentId, workspacePath })
          .pipe(Effect.mapError(mapResumeError(harnessAgentId, harnessSessionId))),
      close: (harnessSessionId) => harness.close(harnessSessionId),
      events: (harnessSessionId) =>
        harness
          .events(harnessSessionId)
          .pipe(Effect.map((stream) => stream.pipe(Stream.map((draft) => draft.body)))),
      prompt: (harnessSessionId, input) => harness.prompt(harnessSessionId, input),
      interrupt: (harnessSessionId) => harness.interrupt(harnessSessionId),
      setModel: (harnessSessionId, model) => harness.setModel(harnessSessionId, model),
      setPermissionMode: (harnessSessionId, permissionMode) =>
        harness.setPermissionMode(harnessSessionId, permissionMode),
      respondToAgentRequest: (harnessSessionId, requestId, response) =>
        harness.respondToAgentRequest(harnessSessionId, requestId, response),
    };
  }),
);
