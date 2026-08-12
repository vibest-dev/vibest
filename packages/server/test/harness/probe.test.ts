import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Ref } from "effect";

import type { HarnessAgentAdapter } from "../../src/harness/adapter";
import { CapabilityProbeFailed } from "../../src/harness/errors";
import { makeHarnessProbe } from "../../src/harness/probe";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";

const adapter = (over: {
  id: HarnessAgentAdapter["id"];
  probeModels?: HarnessAgentAdapter["probeModels"];
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.id },
  checkAvailability: Effect.succeed({ available: true }),
  permissionModes: [],
  ...(over.probeModels ? { probeModels: over.probeModels } : {}),
  open: () => Effect.die("probe must not open a session"),
  resume: () => Effect.die("probe must not resume a session"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

/** Records every cwd it is probed with, and yields so callers can actually race. */
const recordingProbe = (seen: Ref.Ref<ReadonlyArray<string>>) => (cwd: string) =>
  Ref.update(seen, (current) => [...current, cwd]).pipe(
    Effect.andThen(Effect.yieldNow),
    Effect.as([{ id: "sonnet", label: "Sonnet" }]),
  );

it.effect("probes the directory it was asked about, grouped under the built-in provider", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const probe = yield* makeHarnessProbe(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", probeModels: recordingProbe(seen) })]),
    );

    const result = yield* probe.probe({ harnessAgentId: "claude-code", cwd: "/work/app" });

    assert.deepEqual(yield* Ref.get(seen), ["/work/app"]);
    // Models never leave their provider: the built-in provider carries the
    // harness's own id, which is the other half of every providerId/modelId pair.
    assert.equal(result.providers[0]?.id, "claude-code");
    assert.equal(result.providers[0]?.models[0]?.id, "sonnet");
  }),
);

it.effect("gives concurrent callers one probe, not one each", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const probe = yield* makeHarnessProbe(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", probeModels: recordingProbe(seen) })]),
    );
    const ask = probe.probe({ harnessAgentId: "claude-code", cwd: "/work/app" });

    // Two tabs on the same directory, arriving before the first probe settles.
    const [first, second] = yield* Effect.all([ask, ask], { concurrency: "unbounded" });

    assert.equal((yield* Ref.get(seen)).length, 1);
    assert.equal(first.providers[0]?.models[0]?.id, "sonnet");
    assert.equal(second.providers[0]?.models[0]?.id, "sonnet");
  }),
);

it.effect("treats two directories as two probes, and does not serialise them", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const probe = yield* makeHarnessProbe(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", probeModels: recordingProbe(seen) })]),
    );

    yield* Effect.all(
      [
        probe.probe({ harnessAgentId: "claude-code", cwd: "/work/a" }),
        probe.probe({ harnessAgentId: "claude-code", cwd: "/work/b" }),
      ],
      { concurrency: "unbounded" },
    );

    // Both ran; if the registration lock covered the probes, the second would
    // have queued behind the first rather than interleaving.
    assert.deepEqual(Array.from(yield* Ref.get(seen)).toSorted(), ["/work/a", "/work/b"]);
  }),
);

it.effect("normalises the directory, so one answer serves its aliases", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const probe = yield* makeHarnessProbe(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", probeModels: recordingProbe(seen) })]),
    );

    yield* probe.probe({ harnessAgentId: "claude-code", cwd: "/work/app" });
    yield* probe.probe({ harnessAgentId: "claude-code", cwd: "/work/app/" });
    yield* probe.probe({ harnessAgentId: "claude-code", cwd: "/work/nested/../app" });

    assert.equal((yield* Ref.get(seen)).length, 1);
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
            ? Effect.succeed([{ id: "sonnet" }])
            : Effect.fail(
                new CapabilityProbeFailed({ harnessAgentId: "claude-code", cause: "boom" }),
              ),
        ),
      );
    const probe = yield* makeHarnessProbe(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", probeModels: flaky })]),
    );
    const ask = probe.probe({ harnessAgentId: "claude-code", cwd: "/work/app" });

    // A cached failure would pin "no models" for the whole TTL, so the user
    // would have to wait it out after logging back in.
    yield* Effect.result(ask);
    assert.equal((yield* ask).providers[0]?.models[0]?.id, "sonnet");
    assert.equal(yield* Ref.get(calls), 2);

    // The success, on the other hand, is worth keeping: no second spawn.
    yield* ask;
    assert.equal(yield* Ref.get(calls), 2);
  }),
);

it.effect("answers an empty provider list for a harness that has no probe", () =>
  Effect.gen(function* () {
    const probe = yield* makeHarnessProbe(makeHarnessAgentRegistry([adapter({ id: "pi" })]));

    // Not a failure: pi genuinely has no models, and the client renders no
    // picker rather than an error.
    assert.deepEqual(yield* probe.probe({ harnessAgentId: "pi", cwd: "/work/app" }), {
      providers: [],
    });
  }),
);
