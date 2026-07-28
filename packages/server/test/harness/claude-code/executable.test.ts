import { describe, expect, it } from "vitest";

import {
  type AvailabilityDeps,
  type AvailabilityResult,
  checkClaudeAvailability,
  type ResolveDeps,
  resolveClaudeExecutable,
} from "../../../src/harness/claude-code/executable";

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

  it("uses the E2E executable override only in E2E mode", () => {
    const resolved = resolveClaudeExecutable(
      deps({
        env: {
          VIBEST_E2E: "1",
          VIBEST_E2E_CLAUDE_EXECUTABLE: "/test/fake-claude",
          VIBEST_CLAUDE_EXECUTABLE: "/custom/claude",
        },
      }),
    );

    expect(resolved).toBe("/test/fake-claude");
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

describe("checkClaudeAvailability (version floor)", () => {
  /** A resolvable executable plus injectable version reader / floor. */
  function availDeps(overrides: AvailabilityDeps = {}): AvailabilityDeps {
    return {
      env: { VIBEST_CLAUDE_EXECUTABLE: "/bin/claude" },
      requiredVersion: () => "2.1.216",
      readVersion: async () => "2.1.216 (Claude Code)",
      ...overrides,
    };
  }

  /** Unconditional reason extractor so assertions never sit behind an `if`. */
  const reasonOf = (result: AvailabilityResult): string => (result.available ? "" : result.reason);

  it("is available when the CLI matches the floor", async () => {
    expect(await checkClaudeAvailability(availDeps())).toEqual({ available: true });
  });

  it("is available when the CLI is newer than the floor", async () => {
    const result = await checkClaudeAvailability(
      availDeps({ readVersion: async () => "2.1.218 (Claude Code)" }),
    );
    expect(result).toEqual({ available: true });
  });

  it("is unavailable with an actionable reason when the CLI is too old", async () => {
    const result = await checkClaudeAvailability(
      availDeps({ readVersion: async () => "2.1.215 (Claude Code)" }),
    );
    expect(result.available).toBe(false);
    expect(reasonOf(result)).toMatch(/2\.1\.215 is too old/);
    expect(reasonOf(result)).toMatch(/2\.1\.216 or newer/);
    expect(reasonOf(result)).toContain("claude.com/claude-code");
  });

  it("compares numerically, not lexically (2.1.9 < 2.1.216)", async () => {
    const result = await checkClaudeAvailability(
      availDeps({ readVersion: async () => "2.1.9 (Claude Code)" }),
    );
    expect(result.available).toBe(false);
  });

  it("fails OPEN when the version cannot be read", async () => {
    const result = await checkClaudeAvailability(
      availDeps({
        readVersion: async () => {
          throw new Error("spawn failed");
        },
      }),
    );
    expect(result).toEqual({ available: true });
  });

  it("fails OPEN when the version string is unparseable", async () => {
    const result = await checkClaudeAvailability(
      availDeps({ readVersion: async () => "unknown build" }),
    );
    expect(result).toEqual({ available: true });
  });

  it("is unavailable with the resolve error when no binary is found", async () => {
    const result = await checkClaudeAvailability({
      env: { PATH: "/usr/bin" },
      home: "/home/din",
      bundled: () => undefined,
      isExecutable: () => false,
      requiredVersion: () => "2.1.216",
      readVersion: async () => "2.1.216 (Claude Code)",
    });
    expect(result.available).toBe(false);
    expect(reasonOf(result)).toMatch(/Claude Code was not found/);
  });
});
