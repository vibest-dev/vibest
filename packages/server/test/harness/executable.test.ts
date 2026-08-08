import { Effect } from "effect";
import { expect, it } from "vitest";

import { executableAt, searchInstallDirs } from "../../src/harness/executable";
import { fakeExecutables, fakeStats, fileInfo } from "../fake-file-system";

// The search primitive every harness's own resolver ends with. Its result is
// what the transport spawns — that is the property these tests are really
// about. It is also what changed: the search used to be PATH-only *because*
// spawn re-resolved a bare name and would have disagreed with anything found
// elsewhere. Now the two are the same answer, so the search is allowed to look
// where a stripped environment's PATH cannot.
const search = (
  deps: Parameters<typeof searchInstallDirs>[1],
  ...installed: ReadonlyArray<string>
) =>
  searchInstallDirs("codex", { home: "/home/din", ...deps }).pipe(
    Effect.provide(fakeExecutables(...installed)),
  );

it("resolves against PATH, in PATH order", () => {
  const resolved = Effect.runSync(
    search(
      { env: { PATH: "/first:/second" }, platform: "darwin" },
      "/first/codex",
      "/second/codex",
    ),
  );

  expect(resolved).toBe("/first/codex");
});

// The regression this whole change exists for: a systemd unit / launchd app /
// non-interactive ssh gets a PATH that never saw a login shell, and every
// bun-, npm- or native-installer-managed CLI lives outside it.
it("finds a CLI installed outside a stripped PATH", () => {
  const resolved = Effect.runSync(
    search({ env: { PATH: "/usr/bin:/bin" }, platform: "darwin" }, "/home/din/.bun/bin/codex"),
  );

  expect(resolved).toBe("/home/din/.bun/bin/codex");
});

it("still lets PATH win over an install directory", () => {
  const resolved = Effect.runSync(
    search(
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
    search({ env: { PATH: "/bin" }, platform: "win32" }, "/bin/codex.cmd"),
  );

  expect(resolved).toBe("/bin/codex.cmd");
});

// `undefined`, not a failure: what to say about "nowhere on this machine" is
// the calling harness's own wording, and some of them have levels left to try.
it("reports nothing found rather than failing", () => {
  const resolved = Effect.runSync(search({ env: { PATH: "/usr/bin:/bin" }, platform: "darwin" }));

  expect(resolved).toBeUndefined();
});

// A directory carries the same execute bits a binary does, and `spawn` cannot
// run one — so the mode check alone would report a false hit.
it("ignores a directory that shares the command's name", () => {
  const resolved = Effect.runSync(
    searchInstallDirs("codex", {
      env: { PATH: "/bin" },
      platform: "darwin",
      home: "/home/din",
    }).pipe(Effect.provide(fakeStats({ "/bin/codex": fileInfo("Directory", 0o755) }))),
  );

  expect(resolved).toBeUndefined();
});

it("verifies a single nominated candidate", () => {
  // The level a harness nominates itself — a copy inside its own package.
  const present = Effect.runSync(
    executableAt("/app/node_modules/.bin/pi", { platform: "darwin" }).pipe(
      Effect.provide(fakeExecutables("/app/node_modules/.bin/pi")),
    ),
  );
  const absent = Effect.runSync(
    executableAt("/app/node_modules/.bin/pi", { platform: "darwin" }).pipe(
      Effect.provide(fakeExecutables()),
    ),
  );

  expect(present).toBe("/app/node_modules/.bin/pi");
  expect(absent).toBeUndefined();
});
