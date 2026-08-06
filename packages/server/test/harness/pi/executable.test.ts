import { Effect } from "effect";
import { expect, it } from "vitest";

import { resolvePiExecutable, type ResolvePiDeps } from "../../../src/harness/pi/executable";
import { fakeExecutables } from "../../fake-file-system";

/** No copy in our own node_modules and nothing installed, unless a test says so. */
const resolve = (overrides: ResolvePiDeps, ...installed: ReadonlyArray<string>) =>
  resolvePiExecutable({
    env: {},
    platform: "darwin",
    home: "/home/din",
    bundled: () => undefined,
    ...overrides,
  }).pipe(Effect.provide(fakeExecutables(...installed)));

it("takes an explicit override ahead of everything, without verifying it", () => {
  // Unverified on purpose: falling back would tell the operator the harness
  // works while silently running a different binary than the one they named.
  const resolved = Effect.runSync(
    resolve(
      {
        env: { VIBEST_PI_EXECUTABLE: "/custom/pi", PATH: "/bin" },
        bundled: () => "/app/node_modules/.bin/pi",
      },
      "/app/node_modules/.bin/pi",
      "/bin/pi",
    ),
  );

  expect(resolved).toBe("/custom/pi");
});

// pi is one of our own dependencies, so a working copy sits next to the server
// whether or not the user ever installed pi — and its version is the one this
// server's RPC vocabulary was written against.
it("prefers vibest's own bundled copy over one on PATH", () => {
  const resolved = Effect.runSync(
    resolve(
      { env: { PATH: "/bin" }, bundled: () => "/app/node_modules/.bin/pi" },
      "/app/node_modules/.bin/pi",
      "/bin/pi",
    ),
  );

  expect(resolved).toBe("/app/node_modules/.bin/pi");
});

it("falls through a bundled copy that is not really on disk", () => {
  // Nominating is best-effort: it resolves in a source checkout and misses in
  // a bundle whose module graph never reached pi.
  const resolved = Effect.runSync(
    resolve({ env: { PATH: "/bin" }, bundled: () => "/app/node_modules/.bin/pi" }, "/bin/pi"),
  );

  expect(resolved).toBe("/bin/pi");
});

it("finds a user install outside a stripped PATH", () => {
  const resolved = Effect.runSync(
    resolve({ env: { PATH: "/usr/bin:/bin" } }, "/home/din/.local/bin/pi"),
  );

  expect(resolved).toBe("/home/din/.local/bin/pi");
});

it("fails with its own remedy when nothing is installed", () => {
  const error = Effect.runSync(Effect.flip(resolve({ env: { PATH: "/usr/bin:/bin" } })));

  expect(error._tag).toBe("ExecutableNotFound");
  expect(error.message).toMatch(/Pi was not found.*VIBEST_PI_EXECUTABLE/s);
});
