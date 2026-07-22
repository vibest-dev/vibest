import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import type { HarnessAgentAdapter } from "../../src/harness/adapter";
import { makeHarnessNegotiation } from "../../src/harness/negotiation";
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
  capabilities: { permissionModes: [{ id: "ask", label: "Ask" }], defaultPermissionMode: "ask" },
  // Negotiation must never reach for one of these: declaring a catalog probe
  // changes nothing about what this call returns.
  probeCatalog: () => Effect.die("negotiate must not probe a catalog"),
  open: () => Effect.die("negotiate must not open a session"),
  resume: () => Effect.die("negotiate must not resume a session"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

it.effect("declares each harness's availability and static capabilities", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([adapter({ id: "claude-code" })]);

    const { harnessAgents } = yield* makeHarnessNegotiation(registry).negotiate;

    NodeAssert.deepStrictEqual(harnessAgents[0], {
      id: "claude-code",
      name: "claude-code",
      available: true,
      capabilities: {
        permissionModes: [{ id: "ask", label: "Ask" }],
        defaultPermissionMode: "ask",
      },
    });
  }),
);

it.effect("keeps declaring capabilities for a harness whose CLI is missing", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([
      adapter({ id: "codex", available: false, reason: "Codex was not found on PATH." }),
    ]);

    const { harnessAgents } = yield* makeHarnessNegotiation(registry).negotiate;

    // The picker greys it out and shows the reason — but what it *would* be
    // able to do has nothing to do with whether it is installed right now.
    NodeAssert.equal(harnessAgents[0]?.available, false);
    NodeAssert.equal(harnessAgents[0]?.reason, "Codex was not found on PATH.");
    NodeAssert.equal(harnessAgents[0]?.capabilities.defaultPermissionMode, "ask");
  }),
);

it.effect("reports every registered harness, in registration order", () =>
  Effect.gen(function* () {
    const registry = makeHarnessAgentRegistry([
      adapter({ id: "claude-code" }),
      adapter({ id: "codex", available: false }),
      adapter({ id: "pi" }),
    ]);

    const { harnessAgents } = yield* makeHarnessNegotiation(registry).negotiate;

    NodeAssert.deepStrictEqual(
      harnessAgents.map((harnessAgent) => harnessAgent.id),
      ["claude-code", "codex", "pi"],
    );
  }),
);
