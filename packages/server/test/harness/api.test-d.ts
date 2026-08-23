import type { Effect, Scope, Stream } from "effect";
import { expectTypeOf, test } from "vitest";

import type {
  AgentOpenError,
  AgentOperationError,
  AgentUnavailable,
  ExecutableNotFound,
  HarnessAgentAdapter,
  HarnessAgentRuntime,
  PromptReceipt,
  SessionClosed,
  TurnAlreadyRunning,
} from "../../src/harness";

test("adapter acquisition is scoped and effect native", () => {
  expectTypeOf<HarnessAgentAdapter["open"]>().returns.toEqualTypeOf<
    Effect.Effect<
      HarnessAgentRuntime,
      AgentUnavailable | ExecutableNotFound | AgentOpenError,
      Scope.Scope
    >
  >();
});

test("session operations expose Effect and Stream only", () => {
  expectTypeOf<HarnessAgentRuntime["events"]>().toMatchTypeOf<Stream.Stream<unknown, unknown>>();
  expectTypeOf<ReturnType<HarnessAgentRuntime["prompt"]>>().toEqualTypeOf<
    Effect.Effect<PromptReceipt, SessionClosed | TurnAlreadyRunning | AgentOperationError>
  >();
  expectTypeOf<HarnessAgentRuntime["close"]>().toEqualTypeOf<Effect.Effect<void>>();
});
