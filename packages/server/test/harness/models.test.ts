import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import type { SessionRef } from "@vibest/contract";
import { Effect, Ref } from "effect";

import type { HarnessAgentAdapter, HarnessAgentRuntime } from "../../src/harness/adapter";
import { DefaultModelFailed, ModelListFailed } from "../../src/harness/errors";
import { makeHarnessModels } from "../../src/harness/models";
import { makeHarnessAgentRegistry } from "../../src/harness/registry";
import type { HarnessAgentSessionManagerShape } from "../../src/harness/session-manager";

const adapter = (over: {
  id: HarnessAgentAdapter["id"];
  listModelProviders?: HarnessAgentAdapter["listModelProviders"];
  getDefaultModel?: HarnessAgentAdapter["getDefaultModel"];
}): HarnessAgentAdapter => ({
  id: over.id,
  descriptor: { id: over.id, name: over.id },
  checkAvailability: Effect.succeed({ available: true }),
  permissionModes: [],
  ...(over.listModelProviders ? { listModelProviders: over.listModelProviders } : {}),
  getDefaultModel: over.getDefaultModel ?? (() => Effect.succeed({})),
  open: () => Effect.die("model listing must not open a managed session"),
  resume: () => Effect.die("model listing must not resume a managed session"),
  getSessionInfo: () => Effect.succeed({ _tag: "unsupported" as const }),
});

const manager = (
  find: (ref: SessionRef) => Effect.Effect<HarnessAgentRuntime | undefined>,
): HarnessAgentSessionManagerShape => ({ peek: find }) as HarnessAgentSessionManagerShape;

const noRuntime = manager(() => Effect.succeed(undefined));

/** Records every cwd it receives and yields so concurrent callers can race. */
const recordingList = (seen: Ref.Ref<ReadonlyArray<string>>) => (cwd: string) =>
  Ref.update(seen, (current) => [...current, cwd]).pipe(
    Effect.andThen(Effect.yieldNow),
    Effect.as([
      {
        id: "claude-code",
        models: [{ id: "sonnet", label: "Sonnet" }],
      },
    ]),
  );

it.effect("lists models for the requested directory", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", listModelProviders: recordingList(seen) }),
      ]),
      noRuntime,
    );

    const result = yield* models.listModels({
      harnessAgentId: "claude-code",
      cwd: "/work/app",
    });

    assert.deepEqual(yield* Ref.get(seen), ["/work/app"]);
    assert.equal(result.providers[0]?.id, "claude-code");
    assert.equal(result.providers[0]?.models[0]?.id, "sonnet");
  }),
);

it.effect("gives concurrent directory callers one underlying query", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", listModelProviders: recordingList(seen) }),
      ]),
      noRuntime,
    );
    const ask = models.listModels({ harnessAgentId: "claude-code", cwd: "/work/app" });

    const [first, second] = yield* Effect.all([ask, ask], { concurrency: "unbounded" });

    assert.equal((yield* Ref.get(seen)).length, 1);
    assert.equal(first.providers[0]?.models[0]?.id, "sonnet");
    assert.equal(second.providers[0]?.models[0]?.id, "sonnet");
  }),
);

it.effect("keeps different directories independent and normalizes aliases", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({ id: "claude-code", listModelProviders: recordingList(seen) }),
      ]),
      noRuntime,
    );

    yield* Effect.all(
      [
        models.listModels({ harnessAgentId: "claude-code", cwd: "/work/a" }),
        models.listModels({ harnessAgentId: "claude-code", cwd: "/work/b" }),
      ],
      { concurrency: "unbounded" },
    );
    yield* models.listModels({ harnessAgentId: "claude-code", cwd: "/work/a/" });
    yield* models.listModels({ harnessAgentId: "claude-code", cwd: "/work/nested/../a" });

    assert.deepEqual(new Set(yield* Ref.get(seen)), new Set(["/work/a", "/work/b"]));
  }),
);

it.effect("caches a success but retries a failure", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const flaky = () =>
      Ref.updateAndGet(calls, (n) => n + 1).pipe(
        Effect.flatMap((n) =>
          n > 1
            ? Effect.succeed([{ id: "claude-code", models: [{ id: "sonnet" }] }])
            : Effect.fail(new ModelListFailed({ harnessAgentId: "claude-code", cause: "boom" })),
        ),
      );
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([adapter({ id: "claude-code", listModelProviders: flaky })]),
      noRuntime,
    );
    const ask = models.listModels({ harnessAgentId: "claude-code", cwd: "/work/app" });

    yield* Effect.result(ask);
    assert.equal((yield* ask).providers[0]?.models[0]?.id, "sonnet");
    assert.equal(yield* Ref.get(calls), 2);

    yield* ask;
    assert.equal(yield* Ref.get(calls), 2);
  }),
);

it.effect("uses the current runtime when sessionId identifies one", () =>
  Effect.gen(function* () {
    const directoryCalls = yield* Ref.make(0);
    const liveCalls = yield* Ref.make(0);
    const runtime = {
      sessionId: "native-1",
      harnessAgentId: "pi",
      listModelProviders: Ref.updateAndGet(liveCalls, (n) => n + 1).pipe(
        Effect.as([
          { id: "anthropic", models: [{ id: "claude-sonnet" }] },
          { id: "openai", models: [{ id: "gpt" }] },
        ]),
      ),
    } as unknown as HarnessAgentRuntime;
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({
          id: "pi",
          listModelProviders: () =>
            Ref.updateAndGet(directoryCalls, (n) => n + 1).pipe(Effect.as([])),
        }),
      ]),
      manager((ref) => Effect.succeed(ref.sessionId === "managed-1" ? runtime : undefined)),
    );

    const result = yield* models.listModels({
      harnessAgentId: "pi",
      cwd: "/work/app",
      ref: {
        projectId: "project-1",
        harnessAgentId: "pi",
        sessionId: "managed-1",
      },
    });

    assert.deepEqual(
      result.providers.map(({ id }) => id),
      ["anthropic", "openai"],
    );
    assert.equal(yield* Ref.get(liveCalls), 1);
    assert.equal(yield* Ref.get(directoryCalls), 0);
  }),
);

it.effect("resolves the default model separately from the cached catalog", () =>
  Effect.gen(function* () {
    const seen = yield* Ref.make<ReadonlyArray<string>>([]);
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({
          id: "pi",
          getDefaultModel: (cwd) =>
            Ref.update(seen, (current) => [...current, cwd]).pipe(
              Effect.as({ providerId: "anthropic", modelId: "claude-sonnet" }),
            ),
        }),
      ]),
      noRuntime,
    );

    const first = yield* models.getDefaultModel({ harnessAgentId: "pi", cwd: "/work/app" });
    const second = yield* models.getDefaultModel({ harnessAgentId: "pi", cwd: "/work/./app" });

    assert.deepEqual(first, { providerId: "anthropic", modelId: "claude-sonnet" });
    assert.deepEqual(second, first);
    assert.deepEqual(yield* Ref.get(seen), ["/work/app", "/work/app"]);
  }),
);

it.effect("retries a failed default-model resolution", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({
          id: "pi",
          getDefaultModel: () =>
            Ref.getAndUpdate(calls, (current) => current + 1).pipe(
              Effect.flatMap((attempt) =>
                attempt === 0
                  ? Effect.fail(new DefaultModelFailed({ harnessAgentId: "pi", cause: "offline" }))
                  : Effect.succeed({ providerId: "openai", modelId: "gpt-5" }),
              ),
            ),
        }),
      ]),
      noRuntime,
    );

    yield* Effect.flip(models.getDefaultModel({ harnessAgentId: "pi", cwd: "/work/app" }));
    const result = yield* models.getDefaultModel({ harnessAgentId: "pi", cwd: "/work/app" });

    assert.deepEqual(result, { providerId: "openai", modelId: "gpt-5" });
    assert.equal(yield* Ref.get(calls), 2);
  }),
);

it.effect("falls back to the directory when sessionId has no live runtime", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make(0);
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([
        adapter({
          id: "pi",
          listModelProviders: () =>
            Ref.updateAndGet(calls, (n) => n + 1).pipe(
              Effect.as([{ id: "anthropic", models: [{ id: "claude-sonnet" }] }]),
            ),
        }),
      ]),
      noRuntime,
    );

    const result = yield* models.listModels({
      harnessAgentId: "pi",
      cwd: "/work/app",
      ref: {
        projectId: "project-1",
        harnessAgentId: "pi",
        sessionId: "cold-session",
      },
    });

    assert.equal(result.providers[0]?.id, "anthropic");
    assert.equal(yield* Ref.get(calls), 1);
  }),
);

it.effect("answers an empty provider list when a harness has no model listing", () =>
  Effect.gen(function* () {
    const models = yield* makeHarnessModels(
      makeHarnessAgentRegistry([adapter({ id: "pi" })]),
      noRuntime,
    );

    assert.deepEqual(yield* models.listModels({ harnessAgentId: "pi", cwd: "/work/app" }), {
      providers: [],
    });
  }),
);
