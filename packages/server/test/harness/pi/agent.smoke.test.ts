import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { makePiAgent } from "../../../src/harness/pi/agent";

layer(NodeServices.layer)("pi live smoke", (it) => {
  it.effect.skipIf(process.env.PI_SMOKE !== "1")(
    "runs one real turn",
    () =>
      Effect.gen(function* () {
        const agent = yield* makePiAgent();
        const { sessionId } = yield* agent.session.create({ cwd: process.cwd() });
        const prompt = yield* agent.session.prompt({
          sessionId,
          text: "Reply with exactly: PONG",
        });
        const chunks = Array.from(yield* Stream.runCollect(prompt.output));
        // A failed model call also ends in `finish` (the run settles either
        // way), so finish alone proves nothing — require actual assistant
        // text. Error chunks are tolerated: transient provider timeouts
        // surface as retryable errors mid-turn and the run still recovers.
        const text = chunks
          .filter((chunk) => chunk.type === "text-delta")
          .map((chunk) => ("delta" in chunk ? chunk.delta : ""))
          .join("");
        assert.match(text, /PONG/i);
        assert.equal(chunks.at(-1)?.type, "finish");
        yield* agent.session.abort(sessionId);
      }),
    120_000,
  );
});
