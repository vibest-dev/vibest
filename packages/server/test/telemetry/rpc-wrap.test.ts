import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";

import { makeRpcWrap } from "../../src/rpc/handlers";
import { structured, type LogRecord } from "../../src/telemetry/format";
import { telemetryRuntimeFromContext } from "../../src/telemetry/runtime";

const captureRuntime = (into: Array<LogRecord>, minimumLogLevel?: "Debug") => {
  const logging = Logger.layer([
    Logger.map(structured, (record) => {
      into.push(record);
    }),
  ]);
  const capture = minimumLogLevel
    ? Layer.merge(logging, Layer.succeed(References.MinimumLogLevel, minimumLogLevel))
    : logging;
  return Effect.map(Layer.build(capture), telemetryRuntimeFromContext);
};

layer(Layer.empty)("rpc effect/wrap", (it) => {
  it.effect("reports a defect with the procedure path", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records));

      const exit = yield* Effect.exit(
        wrap(Effect.die(new Error("boom")), { path: ["session", "prompt"] }),
      );

      assert.ok(exit._tag === "Failure");
      const record = records.find((candidate) => candidate.annotations.event === "rpc.failed");
      assert.ok(record !== undefined);
      assert.equal(record.level, "ERROR");
      assert.equal(record.annotations.procedure, "session.prompt");
      assert.ok(String(record.cause).includes("boom"));
    }),
  );

  it.effect("reports a typed failure the router did not map", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records));

      yield* Effect.exit(wrap(Effect.fail("store unavailable"), { path: ["project", "list"] }));

      const failure = records.find((record) => record.annotations.event === "rpc.failed");
      assert.equal(failure?.annotations.procedure, "project.list");
    }),
  );

  it.effect("stays silent when the caller disconnects", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records));

      const exit = yield* Effect.exit(wrap(Effect.interrupt, { path: ["session", "subscribe"] }));

      assert.ok(exit._tag === "Failure");
      assert.deepEqual(records, []);
    }),
  );

  it.effect("stamps a shared traceId on every line the procedure produces", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records));

      yield* wrap(
        Effect.gen(function* () {
          yield* Effect.logInfo("reading the store").pipe(Effect.withSpan("store.read"));
          yield* Effect.logInfo("opening the harness");
        }),
        { path: ["session", "prompt"] },
      );

      const [inner, outer] = records;
      assert.ok(inner !== undefined && outer !== undefined);
      assert.equal(inner.traceId, outer.traceId);
      assert.equal(inner.span, "rpc.session.prompt > store.read");
      assert.equal(outer.span, "rpc.session.prompt");
    }),
  );

  it.effect("records every call as a timed span", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records, "Debug"));

      yield* wrap(Effect.succeed(1), { path: ["project", "list"] });
      yield* Effect.exit(wrap(Effect.fail("nope"), { path: ["session", "prompt"] }));
      yield* Effect.exit(wrap(Effect.interrupt, { path: ["session", "subscribe"] }));

      const spans = records.filter((record) => record.annotations.event === "span");
      assert.deepEqual(
        spans.map((span) => [span.message, span.annotations.outcome, span.level]),
        [
          ["rpc.project.list", "ok", "DEBUG"],
          ["rpc.session.prompt", "error", "WARN"],
          ["rpc.session.subscribe", "interrupted", "DEBUG"],
        ],
      );
      assert.ok(spans.every((span) => typeof span.annotations.durationMs === "number"));
      assert.ok(spans.every((span) => typeof span.traceId === "string"));
      assert.ok(spans.every((span) => span.span === span.message));
    }),
  );

  it.effect("carries the caller's span annotations onto the span line", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records, "Debug"));

      yield* wrap(Effect.void, { path: ["session", "close"] }).pipe(
        Effect.annotateSpans({ sessionId: "session-1" }),
      );

      const span = records.find((record) => record.annotations.event === "span");
      assert.equal(span?.annotations.sessionId, "session-1");
      assert.equal(typeof span?.traceId, "string");
      assert.equal(span?.span, "rpc.session.close");
    }),
  );

  it.effect("keeps telemetry failures from changing the procedure exit", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Layer.merge(
          Logger.layer([
            Logger.make(() => {
              throw new Error("logger failed");
            }),
          ]),
          Layer.succeed(References.MinimumLogLevel, "Debug"),
        ),
      );
      const wrap = makeRpcWrap(telemetryRuntimeFromContext(context));

      const value = yield* wrap(Effect.succeed(1), { path: ["project", "list"] });
      assert.equal(value, 1);
    }),
  );

  it.effect("stays quiet at the default level", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records));

      yield* wrap(Effect.succeed(1), { path: ["project", "list"] });

      assert.deepEqual(records, []);
    }),
  );

  it.effect("leaves a successful procedure's value untouched", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureRuntime(records));

      const value = yield* wrap(Effect.succeed({ ok: true }), { path: ["harness", "list"] });

      assert.deepEqual(value, { ok: true });
      assert.deepEqual(records, []);
    }),
  );
});
