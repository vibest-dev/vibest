import { Effect } from "effect";
import { expect, it } from "vitest";

import {
  type HarnessExecutableSpec,
  type ResolveExecutableDeps,
  resolveHarnessExecutable,
} from "../../src/harness/executable";
import { fakeExecutables, fakeStats, fileInfo } from "../fake-file-system";

// This resolver's result is what the transport spawns — that is the property
// every test here is really about. It is also what changed: the search used to
// be PATH-only *because* spawn re-resolved a bare name and would have
// disagreed with anything found elsewhere. Now the two are the same answer, so
// the search is allowed to look where a stripped environment's PATH cannot.
const spec = (over: Partial<HarnessExecutableSpec> = {}): HarnessExecutableSpec => ({
  harnessAgentId: "codex",
  binaryName: "codex",
  override: () => undefined,
  notFoundReason: "Codex was not found. Install it, or set VIBEST_CODEX_EXECUTABLE.",
  ...over,
});

const resolve = (
  overrides: Partial<HarnessExecutableSpec>,
  deps: ResolveExecutableDeps,
  ...installed: ReadonlyArray<string>
) =>
  resolveHarnessExecutable(spec(overrides), { home: "/home/din", ...deps }).pipe(
    Effect.provide(fakeExecutables(...installed)),
  );

it("resolves against PATH, in PATH order", () => {
  const resolved = Effect.runSync(
    resolve(
      {},
      { env: { PATH: "/first:/second" }, platform: "darwin" },
      "/first/codex",
      "/second/codex",
    ),
  );

  expect(resolved).toBe("/first/codex");
});

it("takes an explicit override ahead of everything, without verifying it", () => {
  // Unverified on purpose: falling back would tell the operator the harness
  // works while silently running a different binary than the one they named.
  const resolved = Effect.runSync(
    resolve(
      { override: (env) => env["VIBEST_CODEX_EXECUTABLE"] },
      { env: { VIBEST_CODEX_EXECUTABLE: "/custom/codex", PATH: "/bin" }, platform: "darwin" },
      "/bin/codex",
    ),
  );

  expect(resolved).toBe("/custom/codex");
});

it("prefers vibest's own bundled copy over one on PATH", () => {
  const resolved = Effect.runSync(
    resolve(
      { bundled: () => "/app/node_modules/.bin/codex" },
      { env: { PATH: "/bin" }, platform: "darwin" },
      "/app/node_modules/.bin/codex",
      "/bin/codex",
    ),
  );

  expect(resolved).toBe("/app/node_modules/.bin/codex");
});

it("falls through a bundled copy that is not really on disk", () => {
  // The bundled level is best-effort by contract: it resolves in a source
  // checkout and misses in a bundle whose module graph lacks the harness.
  const resolved = Effect.runSync(
    resolve(
      { bundled: () => "/app/node_modules/.bin/codex" },
      { env: { PATH: "/bin" }, platform: "darwin" },
      "/bin/codex",
    ),
  );

  expect(resolved).toBe("/bin/codex");
});

// The regression this whole change exists for: a systemd unit / launchd app /
// non-interactive ssh gets a PATH that never saw a login shell, and every
// bun-, npm- or native-installer-managed CLI lives outside it.
it("finds a CLI installed outside a stripped PATH", () => {
  const resolved = Effect.runSync(
    resolve({}, { env: { PATH: "/usr/bin:/bin" }, platform: "darwin" }, "/home/din/.bun/bin/codex"),
  );

  expect(resolved).toBe("/home/din/.bun/bin/codex");
});

it("still lets PATH win over an install directory", () => {
  const resolved = Effect.runSync(
    resolve(
      {},
      { env: { PATH: "/usr/bin" }, platform: "darwin" },
      "/usr/bin/codex",
      "/home/din/.bun/bin/codex",
    ),
  );

  expect(resolved).toBe("/usr/bin/codex");
});

// Paths stay posix-shaped because `node:path` follows the host running the
// test, not the `platform` we pass in; only the extension probing is under
// test here, and that is the part `platform` actually drives.
it("finds the .cmd shim npm installs on Windows, not just .exe", () => {
  const resolved = Effect.runSync(
    resolve({}, { env: { PATH: "/bin" }, platform: "win32" }, "/bin/codex.cmd"),
  );

  expect(resolved).toBe("/bin/codex.cmd");
});

it("fails with the harness's own remedy when nothing is installed", () => {
  // The reason travels on the error so the log line, the RPC message and the
  // greyed-out harness's tooltip are all the same words.
  const error = Effect.runSync(
    Effect.flip(resolve({}, { env: { PATH: "/usr/bin:/bin" }, platform: "darwin" })),
  );

  expect(error._tag).toBe("ExecutableNotFound");
  expect(error.message).toMatch(/Codex was not found.*VIBEST_CODEX_EXECUTABLE/s);
});

// A directory carries the same execute bits a binary does, and `spawn` cannot
// run one — so the mode check alone would report a false hit.
it("ignores a directory that shares the command's name", () => {
  const error = Effect.runSync(
    Effect.flip(
      resolveHarnessExecutable(spec(), {
        env: { PATH: "/bin" },
        platform: "darwin",
        home: "/home/din",
      }).pipe(Effect.provide(fakeStats({ "/bin/codex": fileInfo("Directory", 0o755) }))),
    ),
  );

  expect(error._tag).toBe("ExecutableNotFound");
});
