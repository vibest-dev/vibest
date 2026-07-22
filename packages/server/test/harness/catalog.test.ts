import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import type { HarnessAgentAdapter } from "../../src/harness/adapter";
import { makeHarnessAgentCatalog } from "../../src/harness/catalog";
import { CapabilityProbeFailed } from "../../src/harness/errors";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";

const adapter = (over: {
  id: HarnessAgentAdapter["id"];
  probeCatalog?: HarnessAgentAdapter["probeCatalog"];
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.id },
  checkAvailability: Effect.succeed({ available: true }),
  capabilities: {},
  ...(over.probeCatalog ? { probeCatalog: over.probeCatalog } : {}),
  open: () => Effect.die("catalog must not open a session"),
  resume: () => Effect.die("catalog must not resume a session"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

/** Records every cwd it is probed with, and yields so callers can actually race. */
const recordingProbe = (seen: Ref.Ref<ReadonlyArray<string>>) => (cwd: string) =>
  Ref.update(seen, (current) => [...current, cwd]).pipe(
    Effect.andThen(Effect.yieldNow),
    Effect.as({ models: [{ id: "sonnet", name: "Sonnet" }], defaultModel: "sonnet" }),
  );

it.effect("probes the directory it was asked about", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const catalog = yield* makeHarnessAgentCatalog(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", probeCatalog: recordingProbe(seen) }),
      ]),
    );

    const result = yield* catalog.get({ harnessAgentId: "claude-code", cwd: "/work/app" });

    NodeAssert.deepStrictEqual(yield* Ref.get(seen), ["/work/app"]);
    NodeAssert.equal(result.defaultModel, "sonnet");
  }),
);

it.effect("gives concurrent callers one probe, not one each", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const catalog = yield* makeHarnessAgentCatalog(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", probeCatalog: recordingProbe(seen) }),
      ]),
    );
    const ask = catalog.get({ harnessAgentId: "claude-code", cwd: "/work/app" });

    // Two tabs on the same directory, arriving before the first probe settles.
    const [first, second] = yield* Effect.all([ask, ask], { concurrency: "unbounded" });

    NodeAssert.equal((yield* Ref.get(seen)).length, 1);
    NodeAssert.equal(first.defaultModel, "sonnet");
    NodeAssert.equal(second.defaultModel, "sonnet");
  }),
);

it.effect("treats two directories as two catalogs, and does not serialise them", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const catalog = yield* makeHarnessAgentCatalog(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", probeCatalog: recordingProbe(seen) }),
      ]),
    );

    yield* Effect.all(
      [
        catalog.get({ harnessAgentId: "claude-code", cwd: "/work/a" }),
        catalog.get({ harnessAgentId: "claude-code", cwd: "/work/b" }),
      ],
      { concurrency: "unbounded" },
    );

    // Both ran; if the registration lock covered the probes, the second would
    // have queued behind the first rather than interleaving.
    NodeAssert.deepStrictEqual((yield* Ref.get(seen)).toSorted(), ["/work/a", "/work/b"]);
  }),
);

it.effect("normalises the directory, so one answer serves its aliases", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const catalog = yield* makeHarnessAgentCatalog(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", probeCatalog: recordingProbe(seen) }),
      ]),
    );

    yield* catalog.get({ harnessAgentId: "claude-code", cwd: "/work/app" });
    yield* catalog.get({ harnessAgentId: "claude-code", cwd: "/work/app/" });
    yield* catalog.get({ harnessAgentId: "claude-code", cwd: "/work/nested/../app" });

    NodeAssert.equal((yield* Ref.get(seen)).length, 1);
  }),
);

it.effect("caches a success but retries a failure", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    // Fails once, then succeeds — the shape of an expired login the user fixes.
    const flaky = () =>
      Ref.updateAndGet(calls, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n > 1
            ? Effect.succeed({ models: [{ id: "sonnet" }], defaultModel: "sonnet" })
            : Effect.fail(
                new CapabilityProbeFailed({ harnessAgentId: "claude-code", cause: "boom" }),
              ),
        ),
      );
    const catalog = yield* makeHarnessAgentCatalog(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", probeCatalog: flaky })]),
    );
    const ask = catalog.get({ harnessAgentId: "claude-code", cwd: "/work/app" });

    // A cached failure would pin "no models" for the whole TTL, so the user
    // would have to wait it out after logging back in.
    yield* Effect.result(ask);
    NodeAssert.equal((yield* ask).defaultModel, "sonnet");
    NodeAssert.equal(yield* Ref.get(calls), 2);

    // The success, on the other hand, is worth keeping: no second spawn.
    yield* ask;
    NodeAssert.equal(yield* Ref.get(calls), 2);
  }),
);

it.effect("answers an empty catalog for a harness that has no probe", () =>
  Effect.gen(function* () {
    const catalog = yield* makeHarnessAgentCatalog(
      makeHarnessAgentRegistry([adapter({ id: "pi" })]),
    );

    // Not a failure: pi genuinely has no models, and the client renders no
    // picker rather than an error.
    NodeAssert.deepStrictEqual(yield* catalog.get({ harnessAgentId: "pi", cwd: "/work/app" }), {});
  }),
);
