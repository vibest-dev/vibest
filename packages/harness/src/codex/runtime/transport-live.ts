import type { Effect, Scope } from "effect";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import { makeCodexTransport, type CodexTransportOptions } from "./transport";
import { makeCodexTransportHolder, type CodexTransportHolder } from "./transport-holder";

export const makeLiveCodexTransportHolder = (
  options: CodexTransportOptions = {},
): Effect.Effect<
  CodexTransportHolder,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> =>
  makeCodexTransportHolder({
    makeTransport: () => makeCodexTransport(options),
  });
