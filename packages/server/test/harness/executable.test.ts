import { Effect } from "effect";
import { expect, it } from "vitest";

import { findExecutable, type FindExecutableDeps } from "../../src/harness/executable";
import { fakeExecutables, fakeStats, fileInfo } from "../fake-file-system";

// The whole point of this resolver is to answer the same question the OS will
// answer when a transport calls `spawn("codex")`. Every test here is about that
// agreement: anything it finds that spawn wouldn't turns a clear "not found on
// PATH" into an opaque ENOENT once the user picks the harness.
const resolve = (
  command: string,
  deps: FindExecutableDeps,
  ...installed: ReadonlyArray<string>
): string | undefined =>
  Effect.runSync(findExecutable(command, deps).pipe(Effect.provide(fakeExecutables(...installed))));

it("resolves a bare command against PATH, in PATH order", () => {
  const resolved = resolve(
    "codex",
    { env: { PATH: "/first:/second" }, platform: "darwin" },
    "/first/codex",
    "/second/codex",
  );

  expect(resolved).toBe("/first/codex");
});

it("does not look outside PATH, because spawn will not either", () => {
  const resolved = resolve(
    "codex",
    { env: { PATH: "/usr/bin" }, platform: "darwin" },
    // Installed, but somewhere this process's PATH does not mention.
    "/Users/someone/.local/bin/codex",
  );

  expect(resolved).toBeUndefined();
});

it("takes an absolute command as an override and only checks it is runnable", () => {
  const deps = { env: { PATH: "" }, platform: "darwin" as const };

  expect(resolve("/opt/codex", deps, "/opt/codex")).toBe("/opt/codex");
  expect(resolve("/opt/missing", deps, "/opt/codex")).toBeUndefined();
});

// Paths stay posix-shaped because `node:path` follows the host running the
// test, not the `platform` we pass in; only the extension probing is under
// test here, and that is the part `platform` actually drives.
it("finds the .cmd shim npm installs on Windows, not just .exe", () => {
  const resolved = resolve("codex", { env: { PATH: "/bin" }, platform: "win32" }, "/bin/codex.cmd");

  expect(resolved).toBe("/bin/codex.cmd");
});

it("reports a missing command as undefined rather than guessing a path", () => {
  expect(resolve("pi", { env: { PATH: "/usr/bin:/bin" }, platform: "darwin" })).toBeUndefined();
});

// A directory carries the same execute bits a binary does, and `spawn` cannot
// run one — so the mode check alone would report a false hit.
it("ignores a directory that shares the command's name", () => {
  const resolved = Effect.runSync(
    findExecutable("codex", { env: { PATH: "/bin" }, platform: "darwin" }).pipe(
      Effect.provide(fakeStats({ "/bin/codex": fileInfo("Directory", 0o755) })),
    ),
  );

  expect(resolved).toBeUndefined();
});
