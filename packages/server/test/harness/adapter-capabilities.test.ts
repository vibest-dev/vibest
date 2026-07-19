import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";

import { makeClaudeCodeAdapter, type ClaudeCodeAgent } from "../../src/harness/claude-code";
import { makeCodexAdapter, type CodexAgent } from "../../src/harness/codex";
import { makePiAdapter, type PiAgent } from "../../src/harness/pi";

// `capabilities` is a pure declaration that never touches the agent, so a stub
// is enough to lock each harness's outward permission-mode vocabulary.
const stub = <T>() => ({}) as T;

it.effect("claude-code negotiates plan/ask/acceptEdits/full", () =>
  Effect.gen(function* () {
    const caps = yield* makeClaudeCodeAdapter(stub<ClaudeCodeAgent>()).capabilities;
    NodeAssert.deepStrictEqual(
      caps.permissionModes?.map((mode) => mode.id),
      ["plan", "ask", "acceptEdits", "full"],
    );
  }),
);

it.effect("codex negotiates read-only/ask/full (no plan)", () =>
  Effect.gen(function* () {
    const caps = yield* makeCodexAdapter(stub<CodexAgent>()).capabilities;
    NodeAssert.deepStrictEqual(
      caps.permissionModes?.map((mode) => mode.id),
      ["read-only", "ask", "full"],
    );
  }),
);

it.effect("pi negotiates no permission modes", () =>
  Effect.gen(function* () {
    const caps = yield* makePiAdapter(stub<PiAgent>()).capabilities;
    NodeAssert.equal(caps.permissionModes, undefined);
  }),
);
