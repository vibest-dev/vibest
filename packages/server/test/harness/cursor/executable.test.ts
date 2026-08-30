import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { layer } from "@effect/vitest";
import { Effect } from "effect";

import {
  checkCursorAvailability,
  resolveCursorExecutable,
} from "../../../src/harness/cursor/executable";

layer(NodeServices.layer)("Cursor executable", (it) => {
  it.effect("honours VIBEST_CURSOR_EXECUTABLE when it is executable", () =>
    Effect.gen(function* () {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-cursor-bin-"));
      const file = path.join(dir, "cursor-agent");
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, 0o755);

      const resolved = yield* resolveCursorExecutable({
        env: { VIBEST_CURSOR_EXECUTABLE: file, PATH: "" },
        home: dir,
      });
      assert.equal(resolved, file);

      const availability = yield* checkCursorAvailability({
        env: { VIBEST_CURSOR_EXECUTABLE: file, PATH: "" },
        home: dir,
      });
      assert.equal(availability.available, true);
    }),
  );

  it.effect("finds cursor-agent under ~/.local/bin when PATH is empty", () =>
    Effect.gen(function* () {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "cursor-home-"));
      const bin = path.join(home, ".local", "bin");
      fs.mkdirSync(bin, { recursive: true });
      const file = path.join(bin, "cursor-agent");
      fs.writeFileSync(file, "#!/bin/sh\n");
      fs.chmodSync(file, 0o755);

      const resolved = yield* resolveCursorExecutable({ env: { PATH: "" }, home });
      assert.equal(resolved, file);
    }),
  );

  it.effect("does not pick up a PATH agent binary", () =>
    Effect.gen(function* () {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-collision-"));
      const pathDir = path.join(home, "bin");
      fs.mkdirSync(pathDir, { recursive: true });
      const agent = path.join(pathDir, "agent");
      fs.writeFileSync(agent, "#!/bin/sh\n");
      fs.chmodSync(agent, 0o755);

      const resolved = yield* resolveCursorExecutable({
        env: { PATH: pathDir },
        home,
      });
      assert.equal(resolved, undefined);
    }),
  );

  it.effect("reports missing when PATH and extra dirs are empty", () =>
    Effect.gen(function* () {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), "empty-cursor-home-"));
      const availability = yield* checkCursorAvailability({ env: { PATH: "" }, home });
      assert.equal(availability.available, false);
      if (availability.available === false) {
        assert.match(availability.reason, /Cursor Agent was not found/);
      }
    }),
  );
});
