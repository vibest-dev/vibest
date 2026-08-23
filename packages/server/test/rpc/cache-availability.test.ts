import assert from "node:assert/strict";

import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, layer } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import type { HarnessAgentAdapter } from "../../src/harness/adapter";
import { cacheAvailability } from "../../src/rpc/runtime";

const unusedAdapter = {
  id: "claude-code",
  descriptor: { id: "claude-code", name: "Claude Code" },
  permissionModes: [],
  open: () => Effect.die("unused"),
  resume: () => Effect.die("unused"),
  getSessionInfo: () => Effect.die("unused"),
} satisfies Omit<HarnessAgentAdapter, "checkAvailability">;

describe("cacheAvailability", () => {
  layer(NodeFileSystem.layer)((it) => {
    it.effect("a caller interrupted mid-check does not poison the cache", () =>
      Effect.gen(function* () {
        // `Effect.cached` stores whatever exit the first caller's fiber
        // observes — forever. Without the uninterruptible guard, a client
        // disconnect during the first `harness.list` stores the interruption
        // and every later call replays it as a defect until server restart.
        const started = yield* Deferred.make<void>();
        const gate = yield* Deferred.make<void>();
        let runs = 0;
        const adapter: HarnessAgentAdapter = {
          ...unusedAdapter,
          checkAvailability: Effect.suspend(() => {
            runs += 1;
            return Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.as({ available: true as const }),
            );
          }),
        };
        const cached = yield* cacheAvailability(adapter);

        const caller = yield* Effect.forkChild(cached.checkAvailability);
        yield* Deferred.await(started);
        // Interrupt while the check is in flight; the guard makes the fiber
        // ride out the interruption, so awaiting it needs the gate open.
        const interruptor = yield* Effect.forkChild(Fiber.interrupt(caller));
        yield* Deferred.succeed(gate, undefined);
        yield* Fiber.await(interruptor);

        const result = yield* cached.checkAvailability;
        assert.deepEqual(result, { available: true });
        // The healthy exit came from the cache, not a rerun.
        assert.equal(runs, 1);
      }),
    );
  });
});
