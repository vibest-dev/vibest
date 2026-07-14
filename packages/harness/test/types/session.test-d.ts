import { expectTypeOf, test } from "vitest";

import type { CreateSessionConfig, LifecycleView, SessionSnapshot } from "../../src/types/session";

test("SessionSnapshot carries cold history + hot active turn + cursor", () => {
  expectTypeOf<SessionSnapshot>().toHaveProperty("history");
  expectTypeOf<SessionSnapshot>().toHaveProperty("activeTurn");
  expectTypeOf<SessionSnapshot["cursor"]>().toEqualTypeOf<number>();
});

test("LifecycleView exposes the active turn and a turn-id minter", () => {
  expectTypeOf<LifecycleView["activeTurnId"]>().toEqualTypeOf<string | undefined>();
  expectTypeOf<LifecycleView["nextTurnId"]>().toEqualTypeOf<() => string>();
});

test("CreateSessionConfig requires a workspace path", () => {
  expectTypeOf<CreateSessionConfig["workspacePath"]>().toEqualTypeOf<string>();
});
