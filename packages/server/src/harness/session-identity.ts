import type { SessionRef } from "@vibest/contract";
import { Effect } from "effect";

/**
 * Bind a session's identity to everything that runs inside — a pipeable, so it
 * is one more step on a pipeline rather than a wrapper that indents the body:
 *
 * ```ts
 * resolveHarnessSessionId(ref).pipe(
 *   Effect.andThen(manager.close(ref)),
 *   inSession(ref),
 * )
 * ```
 *
 * The point is that nothing downstream has to name the session. Both
 * annotation channels are scoped rather than per-call, so this reaches the
 * manager's lines, the session's, and an adapter's — and an adapter is handed
 * `cwd` and has never heard of a `SessionRef`. Without it only the places that
 * remembered to spell out `sessionId` could be found by one.
 *
 * Both channels because local logs need stable join keys while native span
 * attributes must carry the same identity for any tracing exporter.
 *
 * The RPC wrapper is the other candidate seam and cannot be one: oRPC hands it
 * the procedure path and nothing else — the decoded input, where the ref lives,
 * never reaches it.
 */
export const inSession =
  (ref: SessionRef) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const identity = {
      sessionId: ref.sessionId,
      projectId: ref.projectId,
      harnessAgentId: ref.harnessAgentId,
    };
    return effect.pipe(Effect.annotateLogs(identity), Effect.annotateSpans(identity));
  };
