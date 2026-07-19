import type { Effect, Scope, Stream } from "effect";
import { expectTypeOf, test } from "vitest";

import type {
  AgentOpenError,
  AgentOperationError,
  AgentUnavailable,
  ExecutableNotFound,
  HarnessAgentAdapter,
  HarnessAgentSession,
  PromptReceipt,
  SessionClosed,
  TurnAlreadyRunning,
} from "../../src/harness";

test("adapter acquisition is scoped and effect native", () => {
  expectTypeOf<HarnessAgentAdapter["open"]>().returns.toEqualTypeOf<
    Effect.Effect<
      HarnessAgentSession,
      AgentUnavailable | ExecutableNotFound | AgentOpenError,
      Scope.Scope
    >
  >();
});

test("session operations expose Effect and Stream only", () => {
  expectTypeOf<HarnessAgentSession["events"]>().toMatchTypeOf<Stream.Stream<unknown, unknown>>();
  expectTypeOf<ReturnType<HarnessAgentSession["prompt"]>>().toEqualTypeOf<
    Effect.Effect<PromptReceipt, SessionClosed | TurnAlreadyRunning | AgentOperationError>
  >();
  expectTypeOf<HarnessAgentSession["close"]>().toEqualTypeOf<Effect.Effect<void>>();
});
