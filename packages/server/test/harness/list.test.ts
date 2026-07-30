import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import type { HarnessAgentAdapter } from "../../src/harness/adapter";
import { makeHarnessList } from "../../src/harness/list";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";

const adapter = (over: {
  id: HarnessAgentAdapter["id"];
  available?: boolean;
  reason?: string;
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.id },
  checkAvailability: Effect.succeed(
    over.available === false
      ? { available: false, ...(over.reason ? { reason: over.reason } : {}) }
      : { available: true },
  ),
  permissionModes: ["ask"],
  defaultPermissionMode: "ask",
  // Listing must never reach for one of these: declaring a model probe
  // changes nothing about what this call returns.
  probeModels: () => Effect.die("list must not probe models"),
  open: () => Effect.die("list must not open a session"),
  resume: () => Effect.die("list must not resume a session"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

it.effect("declares each harness's availability and permission subset", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([adapter({ id: "claude-code" })]);

    const { harnessAgents } = yield* makeHarnessList(registry).list;

    assert.deepEqual(harnessAgents[0], {
      id: "claude-code",
      name: "claude-code",
      available: true,
      permissionModes: ["ask"],
      defaultPermissionMode: "ask",
    });
  }),
);

it.effect("keeps declaring settings for a harness whose CLI is missing", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([
      adapter({ id: "codex", available: false, reason: "Codex was not found on PATH." }),
    ]);

    const { harnessAgents } = yield* makeHarnessList(registry).list;

    // The picker greys it out and shows the reason — but what it *would* be
    // able to do has nothing to do with whether it is installed right now.
    assert.equal(harnessAgents[0]?.available, false);
    assert.equal(harnessAgents[0]?.reason, "Codex was not found on PATH.");
    assert.equal(harnessAgents[0]?.defaultPermissionMode, "ask");
  }),
);

it.effect("reports every registered harness, in registration order", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([
      adapter({ id: "claude-code" }),
      adapter({ id: "codex", available: false }),
      adapter({ id: "pi" }),
    ]);

    const { harnessAgents } = yield* makeHarnessList(registry).list;

    assert.deepEqual(
      harnessAgents.map((harnessAgent) => harnessAgent.id),
      ["claude-code", "codex", "pi"],
    );
  }),
);
