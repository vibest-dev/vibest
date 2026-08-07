import assert from "node:assert/strict";
import path from "node:path";

import { layer } from "@effect/vitest";
import { Effect, FileSystem, Logger } from "effect";

import { makeFileLogger, structured, type LogRecord } from "../../src/telemetry";
import { NodePlatformLayer } from "../platform";

/** Collect `LogRecord`s instead of writing them anywhere. */
const capture = (into: Array<LogRecord>): Logger.Logger<unknown, void> =>
  Logger.map(structured, (record) => {
    into.push(record);
  });

/** Must match `file-sink.ts`'s local-time day key. */
const todayKey = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

// `excludeTestServices` because the retention sweep and the file name both read
// a real clock; the default `TestClock` sits at epoch 0, which would put every
// file 56 years in the future and make the sweep a no-op.
layer(NodePlatformLayer, { excludeTestServices: true })("telemetry logging", (it) => {
  it.effect("carries the enclosing spans into every log line", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      yield* Effect.log("opening").pipe(
        Effect.withSpan("harness.open"),
        Effect.withSpan("rpc.session.prompt"),
        Effect.provide(Logger.layer([capture(records)])),
      );

      const record = records[0];
      assert.equal(records.length, 1);
      assert.ok(record !== undefined);
      // The whole point: not one log statement mentions tracing, yet each line
      // knows where in the causal chain it happened.
      assert.equal(record.span, "rpc.session.prompt > harness.open");
      assert.equal(typeof record.traceId, "string");
      assert.equal(typeof record.spanId, "string");
    }),
  );

  it.effect("shares one traceId across every line of the same chain", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      yield* Effect.gen(function* () {
        yield* Effect.log("a").pipe(Effect.withSpan("child"));
        yield* Effect.log("b");
      }).pipe(
        Effect.withSpan("rpc.session.prompt"),
        Effect.provide(Logger.layer([capture(records)])),
      );

      assert.equal(records.length, 2);
      const [first, second] = records;
      assert.ok(first !== undefined && second !== undefined);
      // This is what makes `jq 'select(.traceId==…)'` reconstruct one request.
      assert.equal(first.traceId, second.traceId);
      assert.notEqual(first.spanId, second.spanId);
    }),
  );

  it.effect("omits the trace fields outside any span", () =>
    Effect.gen(function* () {
      const records: Array<LogRecord> = [];
      yield* Effect.log("standalone").pipe(Effect.provide(Logger.layer([capture(records)])));

      const record = records[0];
      assert.ok(record !== undefined);
      assert.equal(record.traceId, undefined);
      assert.equal(record.span, undefined);
    }),
  );

  it.effect("writes JSON lines to a per-day file and flushes on scope close", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      yield* Effect.gen(function* () {
        const logger = yield* makeFileLogger({ directory, retentionDays: 30 });
        yield* Effect.log("persisted").pipe(
          Effect.annotateLogs({ event: "test.persisted" }),
          Effect.withSpan("rpc.session.prompt"),
          Effect.provide(Logger.layer([logger])),
        );
        // No sleep: closing the scope flushes whatever the batch window has not.
      }).pipe(Effect.scoped);

      const content = yield* fs.readFileString(path.join(directory, `server-${todayKey()}.jsonl`));
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 1);

      const parsed = JSON.parse(lines[0] ?? "") as LogRecord;
      assert.equal(parsed.annotations.event, "test.persisted");
      assert.equal(parsed.span, "rpc.session.prompt");
      assert.equal(typeof parsed.traceId, "string");
    }),
  );

  it.effect("drops days past the retention window and keeps the rest", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const stale = path.join(directory, "server-2000-01-01.jsonl");
      const fresh = path.join(directory, `server-${todayKey()}.jsonl`);
      const unrelated = path.join(directory, "daemon-stdio.log");
      yield* fs.writeFileString(stale, "{}\n");
      yield* fs.writeFileString(fresh, "{}\n");
      yield* fs.writeFileString(unrelated, "not ours\n");

      yield* Effect.scoped(Effect.asVoid(makeFileLogger({ directory, retentionDays: 30 })));

      assert.equal(yield* fs.exists(stale), false);
      assert.equal(yield* fs.exists(fresh), true);
      // Only `server-<date>.jsonl` is ours to delete.
      assert.equal(yield* fs.exists(unrelated), true);
    }),
  );

  // The lines carry working directories, project/session ids and agent stderr.
  // The default 0644 would hand all of that to every other account on the
  // machine — `daemon.pid`, which holds the auth token, has always been 0600,
  // and there is no reason for the logs beside it to be laxer.
  it.effect("keeps the log owner-only, like the rest of $VIBEST_HOME", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const parent = yield* fs.makeTempDirectoryScoped();
      const directory = path.join(parent, "logs");

      yield* Effect.gen(function* () {
        const logger = yield* makeFileLogger({ directory, retentionDays: 30 });
        yield* Effect.log("secret-ish").pipe(Effect.provide(Logger.layer([logger])));
      }).pipe(Effect.scoped);

      const file = yield* fs.stat(path.join(directory, `server-${todayKey()}.jsonl`));
      const dir = yield* fs.stat(directory);
      // `mode` carries the file type bits too; mask down to the permissions.
      assert.equal((Number(file.mode) & 0o777).toString(8), "600");
      assert.equal((Number(dir.mode) & 0o777).toString(8), "700");
    }),
  );

  it.effect("survives an unwritable directory rather than failing the server", () =>
    Effect.gen(function* () {
      // A path whose parent is a file cannot be created; logging must degrade,
      // not take the process down with it.
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const blocked = path.join(directory, "blocker", "logs");
      yield* fs.writeFileString(path.join(directory, "blocker"), "");

      const logger = yield* Effect.scoped(
        makeFileLogger({ directory: blocked, retentionDays: 30 }),
      );
      assert.ok(Logger.isLogger(logger));
    }),
  );
});
