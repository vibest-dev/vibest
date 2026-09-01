import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect } from "effect";

import { checkGrokAvailability, resolveGrokExecutable } from "../../../src/harness/grok/executable";

layer(NodeServices.layer)("Grok executable", (it) => {
  it.effect("honours VIBEST_GROK_EXECUTABLE when it is executable", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-grok-bin-"));
      const file = path.join(dir, "grok");
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, 0o755);

      const resolved = yield* resolveGrokExecutable({
        env: { VIBEST_GROK_EXECUTABLE: file, PATH: "" },
        home: dir,
      });
      assert.equal(resolved, file);

      const availability = yield* checkGrokAvailability({
        env: { VIBEST_GROK_EXECUTABLE: file, PATH: "" },
        home: dir,
      });
      assert.equal(availability.available, true);
    }),
  );

  it.effect("reports missing when PATH and extra dirs are empty", () =>
    Effect.gen(function* () {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "empty-grok-home-"));
      const availability = yield* checkGrokAvailability({ env: { PATH: "" }, home });
      assert.equal(availability.available, false);
      if (availability.available === false) {
        assert.match(availability.reason, /Grok was not found/);
      }
    }),
  );
});
