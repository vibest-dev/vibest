import assert from "node:assert/strict";

import { layer as testLayer } from "@effect/vitest";
import { Crypto, Effect, FileSystem, Layer, PlatformError } from "effect";

import { layerPaths, logsDirectory, vibestLogPath } from "../../src/config/paths";
import * as Observability from "../../src/observability";
import { NodePlatformLayer } from "../platform";

const withLogs = (home: string, effect: Effect.Effect<void>) =>
  effect.pipe(
    Effect.provide(Observability.layer()),
    Effect.provide(layerPaths(home)),
    Effect.scoped,
  );

testLayer(NodePlatformLayer, { excludeTestServices: true })("observability logging", (it) => {
  it.effect("appends local logfmt and flushes when the layer closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const logsDir = logsDirectory(home);

      yield* withLogs(
        home,
        Effect.logInfo("persisted").pipe(
          Effect.annotateLogs({ event: "test.persisted", nested: { value: 1 } }),
          Effect.andThen(Effect.logDebug("filtered")),
        ),
      );

      const logs = yield* fs.stat(logsDir);
      const file = yield* fs.stat(vibestLogPath(logsDir));
      assert.equal((Number(logs.mode) & 0o777).toString(8), "700");
      assert.equal((Number(file.mode) & 0o777).toString(8), "600");

      const content = yield* fs.readFileString(vibestLogPath(logsDir));
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /^timestamp=\S+ level=INFO run=[a-f0-9]{8} /);
      assert.match(lines[0] ?? "", /message=persisted/);
      assert.match(lines[0] ?? "", /event=test\.persisted/);
      assert.match(lines[0] ?? "", /nested\.value=1/);
    }),
  );

  it.effect("stamps the process run id from Crypto", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const real = yield* Crypto.Crypto;
      const fixedCrypto = Layer.succeed(Crypto.Crypto, {
        ...real,
        randomUUIDv4: Effect.succeed("deadbeef-0000-4000-8000-000000000000"),
      });

      yield* Effect.logInfo("hello").pipe(
        Effect.provide(Observability.layer()),
        Effect.provide(layerPaths(home)),
        Effect.provide(fixedCrypto),
        Effect.scoped,
      );

      const content = yield* fs.readFileString(vibestLogPath(logsDirectory(home)));
      assert.match(content, /run=deadbeef /);
    }),
  );

  it.effect("treats an RNG failure minting a run id as a defect", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const real = yield* Crypto.Crypto;
      const brokenCrypto = Layer.succeed(Crypto.Crypto, {
        ...real,
        randomUUIDv4: Effect.fail(
          PlatformError.badArgument({ module: "Crypto", method: "randomUUIDv4" }),
        ),
      });

      const exit = yield* Effect.exit(
        Effect.logInfo("hello").pipe(
          Effect.provide(Observability.layer()),
          Effect.provide(layerPaths(home)),
          Effect.provide(brokenCrypto),
          Effect.scoped,
        ),
      );
      assert.equal(exit._tag, "Failure");
    }),
  );

  it.effect("appends concurrent runs with a run on every line", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const write = Effect.forEach(
        Array.from({ length: 50 }, (_, index) => index),
        (index) => Effect.logInfo(`entry-${index}`),
      ).pipe(
        Effect.provide(Observability.layer()),
        Effect.provide(layerPaths(home)),
        Effect.scoped,
      );

      yield* Effect.all([write, write], { concurrency: "unbounded" });

      const content = yield* fs.readFileString(vibestLogPath(logsDirectory(home)));
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 100);

      const runs = [
        ...new Set(
          lines.map((line) => {
            const match = /(?:^| )run=(\S+)/.exec(line);
            return match?.[1];
          }),
        ),
      ];
      assert.equal(runs.length, 2);
      assert.equal(lines.filter((line) => line.includes(`run=${runs[0]}`)).length, 50);
      assert.equal(lines.filter((line) => line.includes(`run=${runs[1]}`)).length, 50);
      assert.ok(
        lines.every((line) => line.startsWith("timestamp=") && line.includes(" level=INFO ")),
      );
      assert.ok(lines.every((line) => !line.includes(" fiber=")));
      assert.ok(lines.every((line) => !line.startsWith("{")));
    }),
  );
});
