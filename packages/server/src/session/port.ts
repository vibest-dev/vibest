import { Context, type Effect } from "effect";

import type { AgentUnavailable, SessionOpenFailed, SessionResumeFailed } from "../errors";
import type { HarnessAgentId } from "../types";

export type HarnessCreateError = AgentUnavailable | SessionOpenFailed;
export type HarnessResumeError = AgentUnavailable | SessionResumeFailed;

/**
 * Narrow lifecycle seam onto the harness runtime. `SessionService` depends on
 * this port, never on `@vibest/harness` directly, so orchestration (projectId
 * resolution, id translation, metadata) can be built and tested against a fake
 * while the real port→harness adapter lands with the harness event rewrite
 * (ticket 08). The port speaks the agent-native session id and a resolved
 * `workspacePath` only — it never sees a projectId or a daemon sessionId.
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
