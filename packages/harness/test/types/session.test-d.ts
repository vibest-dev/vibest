import { expectTypeOf, test } from "vitest";

import type { CreateSessionConfig, LifecycleView } from "../../src/types/session";

test("LifecycleView exposes the active turn and a turn-id minter", () => {
  expectTypeOf<LifecycleView["activeTurnId"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<LifecycleView["nextTurnId"]>().toEqualTypeOf<() => string>();
});

test("CreateSessionConfig requires a workspace path", () => {
  expectTypeOf<CreateSessionConfig["workspacePath"]>().toEqualTypeOf<string>();
});
