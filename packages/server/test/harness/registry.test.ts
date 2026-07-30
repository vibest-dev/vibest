import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import type { HarnessAgentAdapter } from "../../src/harness/adapter";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";

const claude = {
  id: "claude-code",
  descriptor: { id: "claude-code", name: "Claude Code" },
  checkAvailability: Effect.succeed({ available: true }),
  permissionModes: [],
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
  open: () => Effect.die("not used"),
  resume: () => Effect.die("not used"),
} satisfies HarnessAgentAdapter;

it.effect("lists adapters and resolves them by harness agent id", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([claude]);

    assert.deepEqual(yield* registry.list, [claude.descriptor]);
    assert.equal(yield* registry.get("claude-code"), claude);
  }),
);

it.effect("returns a typed error for an unregistered harness agent", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([claude]);
    const error = yield* registry.get("codex").pipe(Effect.flip);

    assert.equal(error._tag, "HarnessAgentNotFound");
    assert.equal(error.harnessAgentId, "codex");
  }),
);
