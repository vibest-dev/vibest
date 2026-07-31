import { describe, expectTypeOf, test } from "vitest";

import type { ThreadItem } from "../../src/codex/protocol/v2";
import type { CodexTools } from "../../src/codex/tools";

type Item<T extends ThreadItem["type"]> = Extract<ThreadItem, { type: T }>;
type In<K extends keyof CodexTools> = CodexTools[K]["input"];
type Out<K extends keyof CodexTools> = CodexTools[K]["output"];

describe("codex tools project ThreadItem arms", () => {
  test("commandExecution", () => {
    expectTypeOf<In<"commandExecution">>().toEqualTypeOf<
      Pick<Item<"commandExecution">, "command" | "cwd" | "commandActions" | "source">
    >();
    expectTypeOf<Out<"commandExecution">>().toEqualTypeOf<
      Pick<
        Item<"commandExecution">,
        "status" | "aggregatedOutput" | "exitCode" | "durationMs" | "processId"
      >
    >();
  });
  test("fileChange", () => {
    expectTypeOf<In<"fileChange">>().toEqualTypeOf<Pick<Item<"fileChange">, "changes">>();
    expectTypeOf<Out<"fileChange">>().toEqualTypeOf<Pick<Item<"fileChange">, "status">>();
  });
  test("webSearch", () => {
    expectTypeOf<In<"webSearch">>().toEqualTypeOf<Pick<Item<"webSearch">, "query">>();
  });
});
