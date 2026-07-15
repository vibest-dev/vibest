import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import type { HarnessAgentAdapter } from "../../src/runtime/adapter";
import { makeHarnessAgentRegistry } from "../../src/runtime/registry";

const claude = {
  id: "claude-code",
  descriptor: { id: "claude-code", name: "Claude Code" },
  checkAvailability: Effect.succeed({ available: true }),
  open: () => Effect.die("not used"),
  resume: () => Effect.die("not used"),
} satisfies HarnessAgentAdapter;

it.effect("lists adapters and resolves them by harness agent id", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([claude]);

    NodeAssert.deepStrictEqual(yield* registry.list, [claude.descriptor]);
    NodeAssert.equal(yield* registry.get("claude-code"), claude);
  }),
);

it.effect("returns a typed error for an unregistered harness agent", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([claude]);
    const error = yield* registry.get("codex").pipe(Effect.flip);

    NodeAssert.equal(error._tag, "HarnessAgentNotFound");
    NodeAssert.equal(error.harnessAgentId, "codex");
  }),
);
