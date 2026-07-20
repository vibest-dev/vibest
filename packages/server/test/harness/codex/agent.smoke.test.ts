import * as NodeAssert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { makeCodexAgent } from "../../../src/harness/codex/agent";

layer(NodeServices.layer)("codex live smoke", (it) => {
  it.effect.skipIf(process.env.CODEX_SMOKE !== "1")(
    "runs one real turn",
    () =>
      Effect.gen(function* () {
        const agent = yield* makeCodexAgent();
        const { sessionId } = yield* agent.session.create({ workspacePath: process.cwd() });
        const prompt = yield* agent.session.prompt({
          sessionId,
          text: "Reply with exactly: PONG",
        });
        const chunks = yield* Stream.runCollect(prompt.output);
        NodeAssert.ok(Array.from(chunks).some((chunk) => chunk.type === "finish"));
        yield* agent.session.abort(sessionId);
      }),
    120_000,
  );
});
