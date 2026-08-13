import type { HarnessAgentId, PermissionMode } from "@vibest/contract";
import { Effect, Stream } from "effect";

import type { HarnessAgentAdapter, HarnessAgentSession } from "../src/harness";

/**
 * The one in-memory `HarnessAgentAdapter` fake for RPC-level tests, so an
 * adapter-interface change lands here instead of in a per-file copy. Declared
 * data (availability, permission subset) comes from `options`; behaviour that
 * a test doesn't exercise dies loudly instead of succeeding silently.
 */
export const makeFakeAdapter = (options: {
  readonly id: HarnessAgentId;
  readonly name?: string;
  readonly available?: boolean;
  readonly reason?: string;
  readonly permissionModes?: ReadonlyArray<PermissionMode>;
  readonly open?: HarnessAgentAdapter["open"];
}): HarnessAgentAdapter => ({
  id: options.id,
  descriptor: { id: options.id, name: options.name ?? options.id },
  checkAvailability: Effect.succeed(
    options.reason
      ? { available: options.available ?? true, reason: options.reason }
      : { available: options.available ?? true },
  ),
  permissionModes: options.permissionModes ?? [],
  open: options.open ?? (() => Effect.die("open is not exercised by this test")),
  resume: () => Effect.die("resume is not exercised by this test"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

/** An in-memory session that stays open and streams nothing. */
export const makeFakeSession = (options: {
  readonly sessionId: string;
  readonly harnessAgentId: HarnessAgentId;
}): HarnessAgentSession => ({
  sessionId: options.sessionId,
  harnessAgentId: options.harnessAgentId,
  events: Stream.never,
  prompt: () => Effect.die("prompt is not exercised by this test"),
  setModel: () => Effect.void,
  setReasoningEffort: () => Effect.void,
  setPermissionMode: () => Effect.void,
  interrupt: Effect.void,
  respondToAgentRequest: () => Effect.die("requests are not exercised by this test"),
  getCapabilities: Effect.die("capabilities are not exercised by this test"),
  close: Effect.void,
});
