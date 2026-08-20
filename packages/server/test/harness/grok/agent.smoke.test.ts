import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Stream } from "effect";

import { makeGrokAgent } from "../../../src/harness/grok/agent";

layer(NodeServices.layer)("grok live smoke", (it) => {
  it.effect.skipIf(process.env.GROK_SMOKE !== "1")(
    "runs one real turn",
    () =>
      Effect.gen(function* () {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-grok-smoke-"));
        const agent = yield* makeGrokAgent();
        const { sessionId } = yield* agent.session.create({ cwd });
        const prompt = yield* agent.session.prompt({
          sessionId,
          text: "Reply with exactly: PONG",
        });
        const chunks = Array.from(yield* Stream.runCollect(prompt.output));
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
