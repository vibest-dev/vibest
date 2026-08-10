import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect, Fiber, Stream } from "effect";

import { makePiAdapter } from "../../../src/harness/pi/adapter";
import { makePiAgent } from "../../../src/harness/pi/agent";

layer(NodeServices.layer)("pi live smoke", (it) => {
  it.effect.skipIf(process.env.PI_SMOKE !== "1")(
    "runs one real turn",
    () =>
      Effect.gen(function* () {
        const agent = yield* makePiAgent();
        const session = yield* makePiAdapter(agent).open({ cwd: process.cwd() });
        const collected = yield* Effect.forkChild(
          Stream.runCollect(
            session.events.pipe(
              Stream.takeUntil((event) => event.body.type === "session.turn.ended"),
            ),
          ),
        );
        yield* session.prompt({ parts: [{ type: "text", text: "Reply with exactly: PONG" }] });
        const events = Array.from(yield* Fiber.join(collected));
        // A failed model call also ends in `finish` (the run settles either
        // way), so finish alone proves nothing — require actual assistant text.
        const text = events
          .map((event) => event.body)
          .filter((body) => body.type === "text-delta")
          .map((chunk) => chunk.delta)
          .join("");
        assert.match(text, /PONG/i);
        assert.ok(events.some((event) => event.body.type === "finish"));
        yield* session.close;
      }),
    120_000,
  );
});
