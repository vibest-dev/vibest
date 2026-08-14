import assert from "node:assert/strict";
import path from "node:path";

import { layer as testLayer } from "@effect/vitest";
import { Effect, FileSystem } from "effect";

import * as Observability from "../../src/observability";
import { NodePlatformLayer } from "../platform";

testLayer(NodePlatformLayer, { excludeTestServices: true })("observability logging", (it) => {
  it.effect("appends local logfmt and flushes when the layer closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();

      yield* Effect.gen(function* () {
        yield* Effect.logInfo("persisted").pipe(
          Effect.annotateLogs({ event: "test.persisted", nested: { value: 1 } }),
        );
        yield* Effect.logDebug("filtered");
      }).pipe(Effect.provide(Observability.layer({ directory })), Effect.scoped);

      const content = yield* fs.readFileString(path.join(directory, "vibest.log"));
      const lines = content.trim().split("\n");
      assert.equal(lines.length, 1);
      assert.match(lines[0] ?? "", /^timestamp=\S+ level=INFO run=[a-f0-9-]{8} /);
      assert.match(lines[0] ?? "", /message=persisted/);
      assert.match(lines[0] ?? "", /event=test\.persisted/);
      assert.match(lines[0] ?? "", /nested\.value=1/);
    }),
  );
});
