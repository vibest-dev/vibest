import assert from "node:assert/strict";

import { layer } from "@effect/vitest";
import { Context, Effect, Layer, Logger } from "effect";

import { makeRpcWrap } from "../../src/rpc/handlers";
import { structured, type LogRecord } from "../log-record";

const captureContext = (into: Array<LogRecord>) =>
  Layer.build(
    Logger.layer([
      Logger.map(structured, (record) => {
        into.push(record);
      }),
    ]),
  );

layer(Layer.empty)("rpc effect/wrap", (it) => {
  it.effect("reports a defect with the procedure path", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

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
      const wrap = makeRpcWrap(yield* captureContext(records));

      yield* Effect.exit(wrap(Effect.fail("store unavailable"), { path: ["project", "list"] }));

      const failure = records.find((record) => record.annotations.event === "rpc.failed");
      assert.equal(failure?.annotations.procedure, "project.list");
    }),
  );

  it.effect("matches oRPC's inner context provision order", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const effectContext = yield* captureContext(records);
      const wrap = makeRpcWrap(effectContext);
      const innerContext = Context.empty();

      yield* Effect.exit(
        wrap(Effect.fail("store unavailable").pipe(Effect.provide(innerContext)), {
          path: ["project", "list"],
        }),
      );

      assert.equal(records[0]?.annotations.event, "rpc.failed");
    }),
  );

  it.effect("stays silent when the caller disconnects", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      const exit = yield* Effect.exit(wrap(Effect.interrupt, { path: ["session", "subscribe"] }));

      assert.ok(exit._tag === "Failure");
      assert.deepEqual(records, []);
    }),
  );

  it.effect("does not emit a synthetic record for a successful span", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      const wrap = makeRpcWrap(yield* captureContext(records));

      yield* wrap(Effect.succeed(1), { path: ["project", "list"] });

      assert.deepEqual(records, []);
    }),
  );

  it.effect("does not invoke the logger for a silent success", () =>
    Effect.gen(function* () {
      const context = yield* Layer.build(
        Logger.layer([
          Logger.make(() => {
            throw new Error("logger failed");
          }),
        ]),
      );
      const wrap = makeRpcWrap(context);
      const value = yield* wrap(Effect.succeed(1), { path: ["project", "list"] });
      assert.equal(value, 1);
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
