import { Effect } from "effect";
import { expect, it } from "vitest";

import { resolveCodexExecutable } from "../../../src/harness/codex/executable";
import { fakeExecutables } from "../../fake-file-system";

const resolve = (env: NodeJS.ProcessEnv, ...installed: ReadonlyArray<string>) =>
  resolveCodexExecutable({ env, platform: "darwin", home: "/home/din" }).pipe(
    Effect.provide(fakeExecutables(...installed)),
  );

it("takes an explicit override ahead of an install, without verifying it", () => {
  // Unverified on purpose: falling back would tell the operator the harness
  // works while silently running a different binary than the one they named.
  const resolved = Effect.runSync(
    resolve({ VIBEST_CODEX_EXECUTABLE: "/custom/codex", PATH: "/bin" }, "/bin/codex"),
  );

  expect(resolved).toBe("/custom/codex");
});

// Codex is the one harness vibest ships no copy of, so the user's own install
// is the whole of its search — including the `bun install -g` directory a
// systemd unit's PATH never carries.
it("finds the user's install, PATH or not", () => {
  const onPath = Effect.runSync(resolve({ PATH: "/usr/bin" }, "/usr/bin/codex"));
  const offPath = Effect.runSync(resolve({ PATH: "/usr/bin" }, "/home/din/.bun/bin/codex"));

  expect(onPath).toBe("/usr/bin/codex");
  expect(offPath).toBe("/home/din/.bun/bin/codex");
});

it("fails with its own remedy when nothing is installed", () => {
  // The reason travels on the error so the log line, the RPC message and the
  // greyed-out harness's tooltip are all the same words.
  const error = Effect.runSync(Effect.flip(resolve({ PATH: "/usr/bin:/bin" })));

  expect(error._tag).toBe("ExecutableNotFound");
  expect(error.message).toMatch(/Codex was not found.*VIBEST_CODEX_EXECUTABLE/s);
});
