import { HarnessAgentSessionService } from "@vibest/harness/runtime";
import type { CreateSessionError, ResumeSessionError } from "@vibest/harness/runtime";
import { Context, Effect, Layer } from "effect";

import { AgentUnavailable, SessionOpenFailed, SessionResumeFailed } from "../errors";
import type { HarnessAgentId } from "../types";

export type HarnessCreateError = AgentUnavailable | SessionOpenFailed;
export type HarnessResumeError = AgentUnavailable | SessionResumeFailed;

/**
 * Narrow lifecycle seam onto the harness runtime. `SessionService` depends on
 * this port, never on `@vibest/harness` directly, so orchestration (projectId
 * resolution, id translation, metadata) can be built and tested against a fake.
 * The port speaks the agent-native session id and a resolved `workspacePath`
 * only — it never sees a projectId or a server sessionId.
 */
export class HarnessSessionsPort extends Context.Service<
  HarnessSessionsPort,
  {
    /** Open a fresh native session; returns the agent-native session id. */
    readonly create: (
      harnessAgentId: HarnessAgentId,
      workspacePath: string,
    ) => Effect.Effect<string, HarnessCreateError>;
    /** Ensure a native session is active again from its stored native id. */
    readonly resume: (
      harnessAgentId: HarnessAgentId,
      harnessSessionId: string,
      workspacePath: string,
    ) => Effect.Effect<void, HarnessResumeError>;
    /** Close a native session; idempotent no-op if it is not active. */
    readonly close: (harnessSessionId: string) => Effect.Effect<void>;
  }
>()("HarnessSessionsPort") {}

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
export const HarnessSessionsPortLayer: Layer.Layer<
  HarnessSessionsPort,
  never,
  HarnessAgentSessionService
> = Layer.effect(
  HarnessSessionsPort,
  Effect.gen(function* () {
    const harness = yield* HarnessAgentSessionService;
    return {
      create: (harnessAgentId, workspacePath) =>
        harness.create(harnessAgentId, { workspacePath }).pipe(
          Effect.map((result) => result.sessionId),
          Effect.mapError(mapCreateError(harnessAgentId)),
        ),
      resume: (harnessAgentId, harnessSessionId, workspacePath) =>
        harness
          .resume({ sessionId: harnessSessionId, harnessAgentId, workspacePath })
          .pipe(Effect.mapError(mapResumeError(harnessAgentId, harnessSessionId))),
      close: (harnessSessionId) => harness.close(harnessSessionId),
    };
  }),
);
