import assert from "node:assert/strict";
import path from "node:path";

import { layer as testLayer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import { layer as telemetryLayer } from "../../src/telemetry";
import type { LogRecord } from "../../src/telemetry/format";
import { NodePlatformLayer } from "../platform";

const todayKey = (): string => {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
};

testLayer(NodePlatformLayer, { excludeTestServices: true })("telemetry layer", (it) => {
  it.effect("installs one scoped logger and flushes native-span logs on close", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      yield* Effect.gen(function* () {
        yield* Effect.logInfo("persisted").pipe(
          Effect.annotateLogs({ event: "test.persisted" }),
          Effect.withSpan("child"),
          Effect.withSpan("root"),
        );
        yield* Effect.logDebug("filtered");
      }).pipe(
        Effect.provide(
          telemetryLayer({
            logsDir: directory,
            minimumLogLevel: "Info",
            consoleFormat: "quiet",
            retentionDays: 30,
          }),
        ),
        Effect.scoped,
      );

      const content = yield* fs.readFileString(path.join(directory, `server-${todayKey()}.jsonl`));
      const records = content
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as LogRecord);

      assert.equal(records.length, 1);
      const record = records[0];
      assert.ok(record !== undefined);
      assert.equal(record.annotations.event, "test.persisted");
      assert.equal(record.span, "root > child");
      assert.equal(typeof record.traceId, "string");
      assert.equal(typeof record.spanId, "string");
      assert.equal(
        records.some((entry) => entry.annotations.event === "span"),
        false,
      );
    }),
  );
});
