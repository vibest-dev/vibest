import { expect, it } from "vitest";

import { findExecutable } from "../../src/harness/executable";

// The whole point of this resolver is to answer the same question the OS will
// answer when a transport calls `spawn("codex")`. Every test here is about that
// agreement: anything it finds that spawn wouldn't turns a clear "not found on
// PATH" into an opaque ENOENT once the user picks the harness.
const found = (...paths: string[]) => {
  const set = new Set(paths);
  return (candidate: string) => set.has(candidate);
};

it("resolves a bare command against PATH, in PATH order", () => {
  const resolved = findExecutable("codex", {
    env: { PATH: "/first:/second" },
    isExecutable: found("/first/codex", "/second/codex"),
    platform: "darwin",
  });

  expect(resolved).toBe("/first/codex");
});

it("does not look outside PATH, because spawn will not either", () => {
  const resolved = findExecutable("codex", {
    env: { PATH: "/usr/bin" },
    // Installed, but somewhere this process's PATH does not mention.
    isExecutable: found("/Users/someone/.local/bin/codex"),
    platform: "darwin",
  });

  expect(resolved).toBeUndefined();
});

it("takes an absolute command as an override and only checks it is runnable", () => {
  const deps = {
    env: { PATH: "" },
    isExecutable: found("/opt/codex"),
    platform: "darwin" as const,
  };

  expect(findExecutable("/opt/codex", deps)).toBe("/opt/codex");
  expect(findExecutable("/opt/missing", deps)).toBeUndefined();
});

// Paths stay posix-shaped because `node:path` follows the host running the
// test, not the `platform` we pass in; only the extension probing is under test
// here, and that is the part `platform` actually drives.
it("finds the .cmd shim npm installs on Windows, not just .exe", () => {
  const resolved = findExecutable("codex", {
    env: { PATH: "/bin" },
    isExecutable: found("/bin/codex.cmd"),
    platform: "win32",
  });

  expect(resolved).toBe("/bin/codex.cmd");
});

it("reports a missing command as undefined rather than guessing a path", () => {
  expect(
    findExecutable("pi", {
      env: { PATH: "/usr/bin:/bin" },
      isExecutable: () => false,
      platform: "darwin",
    }),
  ).toBeUndefined();
});
