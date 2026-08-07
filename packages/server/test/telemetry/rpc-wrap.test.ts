import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import { Effect, Layer, Logger, References } from "effect";

import { makeRpcWrap } from "../../src/rpc/handlers";
import { SpanLoggerLayer, structured, type LogRecord } from "../../src/telemetry";

const captureContext = (into: Array<LogRecord>) =>
  Layer.build(
    Logger.layer([
      Logger.map(structured, (record) => {
        into.push(record);
      }),
    ]),
  );

/**
 * `effect/wrap` is what replaced `console.error("[rpc]", …)`. It is the only
 * error reporting the ~25 procedures have, so what it does and does not report
 * is worth pinning down.
 */
layer(Layer.empty)("rpc effect/wrap", (it) => {
  it.effect("reports a defect with the procedure path", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      const exit = yield* Effect.exit(
        wrap(Effect.die(new Error("boom")), { path: ["session", "prompt"] }),
      );

      assert.ok(exit._tag === "Failure");
      assert.equal(records.length, 1);
      const record = records[0];
      assert.ok(record !== undefined);
      assert.equal(record.level, "ERROR");
      assert.equal(record.annotations.event, "rpc.failed");
      assert.equal(record.annotations.procedure, "session.prompt");
      assert.ok(String(record.cause).includes("boom"));
    }),
  );

  it.effect("reports a typed failure the router did not map", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      yield* Effect.exit(wrap(Effect.fail("store unavailable"), { path: ["project", "list"] }));

      assert.equal(records.length, 1);
      assert.equal(records[0]?.annotations.procedure, "project.list");
    }),
  );

  // A browser tab closing mid-request interrupts the handler fiber. That is
  // routine, and logging it as a server error would bury the real failures
  // under noise from every navigation.
  it.effect("stays silent when the caller disconnects", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      const exit = yield* Effect.exit(wrap(Effect.interrupt, { path: ["session", "subscribe"] }));

      assert.ok(exit._tag === "Failure");
      assert.deepEqual(records, []);
    }),
  );

  // The whole point of the span: a procedure's own logs, and the logs of
  // everything it calls, share one `traceId` — without any of them knowing.
  it.effect("stamps a shared traceId on every line the procedure produces", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

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

  // The per-call record is the span, not a log statement — `makeRpcWrap` never
  // reads a clock. Installing the span logger is what turns the `withSpan` it
  // already had into that record, so this is the test that the wrapper needs no
  // logging code of its own.
  const captureSpans = (into: Array<LogRecord>) => {
    const logging = Layer.mergeAll(
      Logger.layer([
        Logger.map(structured, (record) => {
          into.push(record);
        }),
      ]),
      Layer.succeed(References.MinimumLogLevel, "Debug"),
    );
    // `provide`, then `merge` — the span logger captures the context it is
    // built in, so building it *beside* the loggers (which is what a single
    // `mergeAll` or a `provideMerge` in the other direction does) silently
    // sends the span lines to Effect's default logger instead.
    return Layer.build(Layer.merge(logging, SpanLoggerLayer.pipe(Layer.provide(logging))));
  };

  it.effect("records every call as a span, timed, without any logging code", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureSpans(records));

      yield* wrap(Effect.succeed(1), { path: ["project", "list"] });
      yield* Effect.exit(wrap(Effect.fail("nope"), { path: ["session", "prompt"] }));
      yield* Effect.exit(wrap(Effect.interrupt, { path: ["session", "subscribe"] }));
      // The span logger writes from a detached fiber, so let it run.
      yield* Effect.yieldNow;

      const spans = records.filter((record) => record.annotations.event === "span");
      assert.deepEqual(
        spans.map((span) => [span.message, span.annotations.outcome, span.level]),
        [
          ["rpc.project.list", "ok", "DEBUG"],
          // A failed span is raised to `warn` so it survives the default floor.
          ["rpc.session.prompt", "error", "WARN"],
          // An interrupt is not a failure. The session drain fiber is
          // interrupted on every normal close, so treating the two alike would
          // put a warning in the log each time a session shuts down cleanly.
          ["rpc.session.subscribe", "interrupted", "DEBUG"],
        ],
      );
      assert.ok(spans.every((span) => typeof span.annotations.durationMs === "number"));
      assert.ok(spans.every((span) => typeof span.annotations.traceId === "string"));
    }),
  );

  // `annotateSpans` is what carries an identity the traced code never named
  // onto the span's own line — the same trick `annotateLogs` does for logs, and
  // the reason `session-service.ts` sets both from one wrap.
  it.effect("carries the caller's span annotations onto the span line", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureSpans(records));

      yield* wrap(Effect.void, { path: ["session", "close"] }).pipe(
        Effect.annotateSpans({ sessionId: "session-1" }),
      );
      yield* Effect.yieldNow;

      const span = records.find((record) => record.annotations.event === "span");
      assert.equal(span?.annotations.sessionId, "session-1");
    }),
  );

  it.effect("stays quiet at the default level", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      yield* wrap(Effect.succeed(1), { path: ["project", "list"] });

      assert.deepEqual(records, []);
    }),
  );

  it.effect("leaves a successful procedure's value untouched", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      const value = yield* wrap(Effect.succeed({ ok: true }), { path: ["harness", "list"] });

      assert.deepEqual(value, { ok: true });
      assert.deepEqual(records, []);
    }),
  );
});
