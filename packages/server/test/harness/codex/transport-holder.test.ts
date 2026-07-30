import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Scope, Stream } from "effect";

import { AgentProcessExited, CodexTransportError } from "../../../src/harness";
import {
  makeCodexTransportHolder,
  type CodexTransport,
  type CodexTransportFailure,
} from "../../../src/harness/codex";

type FakeTransportControl = {
  readonly transport: CodexTransport;
  readonly crash: (error: CodexTransportFailure) => Effect.Effect<boolean>;
};

const makeFakeTransport: Effect.Effect<FakeTransportControl> = Effect.gen(function* () {
  const terminated = yield* Ref.make(false);
  const termination = yield* Deferred.make<never, CodexTransportFailure>();
  const transport: CodexTransport = {
    request: () => Effect.die("unused"),
    notify: () => Effect.void,
    notifications: Stream.empty,
    serverRequests: Stream.empty,
    respond: () => Effect.void,
    respondError: () => Effect.void,
    isTerminated: Ref.get(terminated),
    awaitTermination: Deferred.await(termination),
  };
  return {
    transport,
    crash: (error: CodexTransportFailure) =>
      Ref.set(terminated, true).pipe(Effect.andThen(Deferred.fail(termination, error))),
  };
});

it.effect("Codex transport holder starts lazily and shares concurrent startup", () =>
  Effect.gen(function* () {
    const buildStarted = yield* Deferred.make<void>();
    const releaseBuild = yield* Deferred.make<void>();
    const buildCount = yield* Ref.make(0);

    const holder = yield* makeCodexTransportHolder({
      makeTransport: () =>
        Effect.gen(function* () {
          yield* Ref.update(buildCount, (count) => count + 1);
          yield* Deferred.succeed(buildStarted, undefined);
          yield* Deferred.await(releaseBuild);
          return (yield* makeFakeTransport).transport;
        }),
    });

    assert.equal(yield* Ref.get(buildCount), 0);

    const first = yield* holder.ensure.pipe(Effect.forkChild);
    const second = yield* holder.ensure.pipe(Effect.forkChild);
    yield* Deferred.await(buildStarted);
    assert.equal(yield* Ref.get(buildCount), 1);

    yield* Deferred.succeed(releaseBuild, undefined);
    const firstTransport = yield* Fiber.join(first);
    const secondTransport = yield* Fiber.join(second);

    assert.strictEqual(firstTransport, secondTransport);
    assert.equal(yield* holder.status, "Running");
  }),
);

it.effect("canceling the first waiter does not cancel shared startup", () =>
  Effect.gen(function* () {
    const buildStarted = yield* Deferred.make<void>();
    const releaseBuild = yield* Deferred.make<void>();
    const buildCount = yield* Ref.make(0);

    const holder = yield* makeCodexTransportHolder({
      makeTransport: () =>
        Effect.gen(function* () {
          yield* Ref.update(buildCount, (count) => count + 1);
          yield* Deferred.succeed(buildStarted, undefined);
          yield* Deferred.await(releaseBuild);
          return (yield* makeFakeTransport).transport;
        }),
    });

    const first = yield* holder.ensure.pipe(Effect.forkChild);
    yield* Deferred.await(buildStarted);
    yield* Fiber.interrupt(first);
    yield* Deferred.succeed(releaseBuild, undefined);

    yield* holder.ensure;
    assert.equal(yield* Ref.get(buildCount), 1);
    assert.equal(yield* holder.status, "Running");
  }),
);

it.effect("fails startup waiters when the owner scope closes", () =>
  Effect.gen(function* () {
    const buildStarted = yield* Deferred.make<void>();
    const ownerScope = yield* Scope.make();
    const holder = yield* makeCodexTransportHolder({
      makeTransport: () =>
        Deferred.succeed(buildStarted, undefined).pipe(Effect.andThen(Effect.never)),
    }).pipe(Effect.provideService(Scope.Scope, ownerScope));

    const waiter = yield* holder.ensure.pipe(Effect.forkChild);
    yield* Deferred.await(buildStarted);
    yield* Scope.close(ownerScope, Exit.void);

    const result = yield* Fiber.await(waiter);
    assert.equal(result._tag, "Failure");
  }),
);

it.effect("resets failed startup so a later call can retry", () =>
  Effect.gen(function* () {
    const buildCount = yield* Ref.make(0);
    const holder = yield* makeCodexTransportHolder({
      makeTransport: () =>
        Ref.getAndUpdate(buildCount, (count) => count + 1).pipe(
          Effect.flatMap((count) =>
            count === 0
              ? Effect.fail(
                  new CodexTransportError({
                    operation: "test-build",
                    cause: new Error("first build failed"),
                  }),
                )
              : makeFakeTransport.pipe(Effect.map((built) => built.transport)),
          ),
        ),
    });

    const firstError = yield* holder.ensure.pipe(Effect.flip);
    assert.equal(firstError._tag, "CodexTransportError");
    assert.equal(yield* holder.status, "Idle");

    yield* holder.ensure;
    assert.equal(yield* Ref.get(buildCount), 2);
    assert.equal(yield* holder.status, "Running");
  }),
);

it.effect("clears a crashed generation and starts a replacement", () =>
  Effect.gen(function* () {
    const builds: Array<FakeTransportControl> = [];
    const holder = yield* makeCodexTransportHolder({
      makeTransport: () =>
        makeFakeTransport.pipe(
          Effect.tap((built) =>
            Effect.sync(() => {
              builds.push(built);
            }),
          ),
          Effect.map((built) => built.transport),
        ),
    });

    const first = yield* holder.ensure;
    const firstBuild = builds[0];
    assert.ok(firstBuild);
    yield* firstBuild!.crash(new AgentProcessExited({ harnessAgentId: "codex", code: 7 }));

    yield* Effect.eventually(
      holder.status.pipe(
        Effect.filterOrFail(
          (status) => status === "Idle",
          () => new Error("still running"),
        ),
      ),
    );

    const second = yield* holder.ensure;
    assert.notStrictEqual(second, first);
    assert.equal(builds.length, 2);
  }),
);
