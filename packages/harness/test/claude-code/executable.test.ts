import { describe, expect, it } from "vitest";

import { type ResolveDeps, resolveClaudeExecutable } from "../../src/claude-code/executable";

/** No SDK binary on disk and nothing executable anywhere, unless a test says so. */
function deps(overrides: ResolveDeps = {}): ResolveDeps {
  return {
    env: {},
    home: "/home/din",
    bundled: () => undefined,
    isExecutable: () => false,
    platform: "darwin",
    ...overrides,
  };
}

describe("resolveClaudeExecutable", () => {
  it("takes the explicit override ahead of everything else", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        env: { VIBEST_CLAUDE_EXECUTABLE: "/custom/claude", PATH: "/usr/bin" },
        bundled: () => "/node_modules/sdk/claude",
        isExecutable: () => true,
      }),
    );

    expect(resolved).toBe("/custom/claude");
  });

  it("prefers the SDK's version-matched binary over one on PATH", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        env: { PATH: "/usr/bin" },
        bundled: () => "/node_modules/sdk/claude",
        isExecutable: () => true,
      }),
    );

    expect(resolved).toBe("/node_modules/sdk/claude");
  });

  it("falls back to PATH when the SDK ships no usable binary — the packaged case", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        env: { PATH: "/opt/nope:/usr/bin" },
        isExecutable: (candidate) => candidate === "/usr/bin/claude",
      }),
    );

    expect(resolved).toBe("/usr/bin/claude");
  });

  it("ignores an SDK binary that resolves but is not executable", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        env: { PATH: "/usr/bin" },
        bundled: () => "/sealed/claude",
        isExecutable: (candidate) => candidate === "/usr/bin/claude",
      }),
    );

    expect(resolved).toBe("/usr/bin/claude");
  });

  it("searches the native installer's directory, which is absent from a GUI app's PATH", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        env: { PATH: "/usr/bin:/bin" },
        isExecutable: (candidate) => candidate === "/home/din/.local/bin/claude",
      }),
    );

    expect(resolved).toBe("/home/din/.local/bin/claude");
  });

  it("looks for claude.exe on Windows", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        platform: "win32",
        env: { PATH: "C:\\bin" },
        isExecutable: (candidate) => candidate.endsWith("claude.exe"),
      }),
    );

    expect(resolved).toContain("claude.exe");
  });

  it("throws something the user can act on when nothing is installed", () => {
    expect(() => resolveClaudeExecutable(deps({ env: { PATH: "/usr/bin" } }))).toThrow(
      /Claude Code was not found.*VIBEST_CLAUDE_EXECUTABLE/s,
    );
  });
});
