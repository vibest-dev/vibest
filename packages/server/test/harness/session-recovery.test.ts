import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { PromptPart, SessionRef } from "@vibest/contract";
import { Deferred, Effect, Fiber, FileSystem } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { makeSessionRecoveryStore } from "../../src/harness/session-recovery";
import { NodePlatformLayer } from "../platform";

const ref: SessionRef = {
  projectId: "67c12f8a-e48f-4d0f-9c21-dbb1b8ef6cc8",
  harnessAgentId: "pi",
  sessionId: "session/../unsafe",
};

const parts: PromptPart[] = [
  { type: "text", text: "keep this prompt" },
  { type: "file", mediaType: "text/plain", url: "file:///tmp/a.txt", filename: "a.txt" },
  { type: "data-inspector", data: [{ file: "src/a.ts", line: 4, column: 2 }] },
];

const submitted = {
  type: "session.prompt.submitted" as const,
  messageId: "message-1",
  parts,
};

const run = <A, E>(program: Effect.Effect<A, E, FileSystem.FileSystem>) =>
  Effect.runPromise(program.pipe(Effect.provide(NodePlatformLayer)));

describe("SessionRecoveryStore", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "vibest-recovery-"));
  });

  afterEach(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("persists real prompt parts and only barriers a later boot", async () => {
    const result = await run(
      Effect.gen(function* () {
        const firstBoot = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );
        yield* firstBoot.beforePublish(ref, submitted);

        const currentBarrier = yield* firstBoot.barrier(ref);
        const secondBoot = yield* makeSessionRecoveryStore(
          directory,
          "boot-2",
          Effect.succeed("recovery-2"),
        );
        const restartedBarrier = yield* secondBoot.barrier(ref);
        return { currentBarrier, restartedBarrier, record: yield* secondBoot.read(ref) };
      }),
    );

    expect(result.currentBarrier).toBeNull();
    expect(result.restartedBarrier).toEqual({
      recoveryId: "recovery-1",
      reason: "server_restart",
      prompts: [{ messageId: "message-1", parts }],
    });
    expect(result.record?.prompts[0]?.parts).toEqual(parts);
    expect(await fs.readdir(directory)).toEqual(["project-67c12f8a-e48f-4d0f-9c21-dbb1b8ef6cc8"]);
  });

  it("rejects a stale acknowledgement without clearing the durable barrier", async () => {
    const result = await run(
      Effect.gen(function* () {
        const firstBoot = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );
        yield* firstBoot.beforePublish(ref, submitted);
        const secondBoot = yield* makeSessionRecoveryStore(
          directory,
          "boot-2",
          Effect.succeed("recovery-2"),
        );
        const error = yield* Effect.flip(secondBoot.acknowledge(ref, "wrong-recovery"));
        return { error, barrier: yield* secondBoot.barrier(ref) };
      }),
    );

    expect(result.error._tag).toBe("StaleRecovery");
    expect(result.barrier?.recoveryId).toBe("recovery-1");
  });

  it("does not expose a recovery record through a mismatched harness ref", async () => {
    const barrier = await run(
      Effect.gen(function* () {
        const firstBoot = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );
        yield* firstBoot.beforePublish(ref, submitted);
        const secondBoot = yield* makeSessionRecoveryStore(
          directory,
          "boot-2",
          Effect.succeed("recovery-2"),
        );
        return yield* secondBoot.barrier({ ...ref, harnessAgentId: "codex" });
      }),
    );

    expect(barrier).toBeNull();
  });

  it("serializes public clear behind a compound prompt write", async () => {
    const record = await run(
      Effect.gen(function* () {
        const idRequested = yield* Deferred.make<void>();
        const releaseId = yield* Deferred.make<void>();
        const store = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Deferred.succeed(idRequested, undefined).pipe(
            Effect.andThen(Deferred.await(releaseId)),
            Effect.as("recovery-1"),
          ),
        );
        const writeFiber = yield* Effect.forkChild(store.beforePublish(ref, submitted));
        yield* Deferred.await(idRequested);
        const clearFiber = yield* Effect.forkChild(store.clear(ref));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(releaseId, undefined);
        yield* Fiber.join(writeFiber);
        yield* Fiber.join(clearFiber);
        return yield* store.read(ref);
      }),
    );

    expect(record).toBeNull();
  });

  it("fails closed when the persisted record is corrupt", async () => {
    const file = path.join(
      directory,
      "project-67c12f8a-e48f-4d0f-9c21-dbb1b8ef6cc8",
      "harness-pi",
      "session-session%2F..%2Funsafe.json",
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{ not json", "utf8");

    const error = await run(
      Effect.gen(function* () {
        const store = yield* makeSessionRecoveryStore(
          directory,
          "boot-2",
          Effect.succeed("recovery-2"),
        );
        return yield* Effect.flip(store.barrier(ref));
      }),
    );

    expect(error._tag).toBe("StoreReadError");
  });

  it("keeps an unaccepted fallback prompt across the old turn end and clears its late steering receipt", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );
        yield* store.beforePublish(ref, {
          type: "session.prompt.submitted",
          messageId: "initial-prompt",
          parts: [{ type: "text", text: "initial" }],
        });
        yield* store.beforePublish(ref, {
          type: "session.prompt.submitted",
          messageId: "fallback-prompt",
          parts: [{ type: "text", text: "steer or start next" }],
        });
        yield* store.beforePublish(ref, {
          type: "session.prompt.accepted",
          messageId: "initial-prompt",
          turnId: "turn-old",
        });
        yield* store.beforePublish(ref, {
          type: "session.turn.ended",
          turnId: "turn-old",
          outcome: "completed",
        });
        const afterOldTurn = yield* store.read(ref);

        // Pi/Codex can return a steering receipt after the native turn-ended
        // event has already crossed the session stream. It belongs to the old
        // turn and must settle only this fallback prompt, never recreate it.
        yield* store.beforePublish(ref, {
          type: "session.prompt.accepted",
          messageId: "fallback-prompt",
          turnId: "turn-old",
        });
        return { afterOldTurn, afterLateFallbackReceipt: yield* store.read(ref) };
      }),
    );

    expect(result.afterOldTurn).toMatchObject({
      prompts: [
        {
          messageId: "fallback-prompt",
          parts: [{ type: "text", text: "steer or start next" }],
        },
      ],
      endedTurnIds: ["turn-old"],
    });
    expect(result.afterLateFallbackReceipt).toBeNull();
  });

  it("keeps an unaccepted prompt for a later turn instead of clearing it with the old turn", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );
        yield* store.beforePublish(ref, {
          type: "session.prompt.submitted",
          messageId: "old-prompt",
          parts: [{ type: "text", text: "old" }],
        });
        yield* store.beforePublish(ref, {
          type: "session.prompt.submitted",
          messageId: "next-prompt",
          parts: [{ type: "text", text: "next" }],
        });
        yield* store.beforePublish(ref, {
          type: "session.prompt.accepted",
          messageId: "old-prompt",
          turnId: "turn-old",
        });
        yield* store.beforePublish(ref, {
          type: "session.turn.ended",
          turnId: "turn-old",
          outcome: "completed",
        });
        yield* store.beforePublish(ref, {
          type: "session.prompt.accepted",
          messageId: "next-prompt",
          turnId: "turn-next",
        });
        const runningNext = yield* store.read(ref);
        yield* store.beforePublish(ref, {
          type: "session.turn.ended",
          turnId: "turn-next",
          outcome: "completed",
        });
        return { runningNext, afterNextTurn: yield* store.read(ref) };
      }),
    );

    expect(result.runningNext?.prompts).toEqual([
      {
        messageId: "next-prompt",
        parts: [{ type: "text", text: "next" }],
        turnId: "turn-next",
      },
    ]);
    expect(result.afterNextTurn).toBeNull();
  });

  it("bounds remembered ended turn ids while unresolved prompts remain", async () => {
    const record = await run(
      Effect.gen(function* () {
        const store = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );
        yield* store.beforePublish(ref, submitted);
        for (let index = 0; index < 40; index += 1) {
          yield* store.beforePublish(ref, {
            type: "session.turn.ended",
            turnId: `turn-${index}`,
            outcome: "completed",
          });
        }
        return yield* store.read(ref);
      }),
    );

    expect(record?.endedTurnIds).toHaveLength(32);
    expect(record?.endedTurnIds.at(0)).toBe("turn-8");
    expect(record?.endedTurnIds.at(-1)).toBe("turn-39");
  });

  it("clears rejected and terminal prompts without recreating after a late acceptance", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* makeSessionRecoveryStore(
          directory,
          "boot-1",
          Effect.succeed("recovery-1"),
        );

        yield* store.beforePublish(ref, submitted);
        yield* store.beforePublish(ref, {
          type: "session.prompt.rejected",
          messageId: "message-1",
          reason: "not accepted",
        });
        const afterRejected = yield* store.read(ref);

        yield* store.beforePublish(ref, submitted);
        yield* store.beforePublish(ref, {
          type: "session.prompt.accepted",
          messageId: "message-1",
          turnId: "turn-1",
        });
        yield* store.beforePublish(ref, {
          type: "session.turn.ended",
          turnId: "turn-1",
          outcome: "completed",
        });
        const afterTerminal = yield* store.read(ref);

        yield* store.beforePublish(ref, submitted);
        yield* store.beforePublish(ref, {
          type: "session.turn.ended",
          turnId: "turn-2",
          outcome: "completed",
        });
        yield* store.beforePublish(ref, {
          type: "session.prompt.accepted",
          messageId: "message-1",
          turnId: "turn-2",
        });
        const afterLateAcceptance = yield* store.read(ref);

        return { afterRejected, afterTerminal, afterLateAcceptance };
      }),
    );

    expect(result).toEqual({
      afterRejected: null,
      afterTerminal: null,
      afterLateAcceptance: null,
    });
  });
});
