import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect } from "effect";
import { describe, expect } from "vitest";

import {
  type AvailabilityDeps,
  type AvailabilityResult,
  checkClaudeAvailability,
  type ResolveDeps,
  resolveClaudeExecutable,
} from "../../../src/harness/claude-code/executable";
import { fakeExecutables } from "../../fake-file-system";

/** No SDK binary on disk and nothing executable anywhere, unless a test says so. */
function deps(overrides: ResolveDeps = {}): ResolveDeps {
  return {
    env: {},
    home: "/home/din",
    bundled: () => undefined,
    platform: "darwin",
    ...overrides,
  };
}

const resolve = (overrides: ResolveDeps, ...installed: ReadonlyArray<string>) =>
  resolveClaudeExecutable(deps(overrides)).pipe(Effect.provide(fakeExecutables(...installed)));

describe("resolveClaudeExecutable", () => {
  it("takes the explicit override ahead of everything else", () => {
    const resolved = Effect.runSync(
      resolve(
        {
          env: { VIBEST_CLAUDE_EXECUTABLE: "/custom/claude", PATH: "/usr/bin" },
          bundled: () => "/node_modules/sdk/claude",
        },
        "/node_modules/sdk/claude",
        "/usr/bin/claude",
      ),
    );

    expect(resolved).toBe("/custom/claude");
  });

  it("uses the E2E executable override only in E2E mode", () => {
    const resolved = Effect.runSync(
      resolve({
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
    const resolved = Effect.runSync(
      resolve(
        { env: { PATH: "/usr/bin" }, bundled: () => "/node_modules/sdk/claude" },
        "/node_modules/sdk/claude",
        "/usr/bin/claude",
      ),
    );

    expect(resolved).toBe("/node_modules/sdk/claude");
  });

  it("falls back to PATH when the SDK ships no usable binary — the packaged case", () => {
    const resolved = Effect.runSync(
      resolve({ env: { PATH: "/opt/nope:/usr/bin" } }, "/usr/bin/claude"),
    );

    expect(resolved).toBe("/usr/bin/claude");
  });

  it("ignores an SDK binary that resolves but is not executable", () => {
    const resolved = Effect.runSync(
      resolve({ env: { PATH: "/usr/bin" }, bundled: () => "/sealed/claude" }, "/usr/bin/claude"),
    );

    expect(resolved).toBe("/usr/bin/claude");
  });

  it("searches the native installer's directory, which is absent from a GUI app's PATH", () => {
    const resolved = Effect.runSync(
      resolve({ env: { PATH: "/usr/bin:/bin" } }, "/home/din/.local/bin/claude"),
    );

    expect(resolved).toBe("/home/din/.local/bin/claude");
  });

  it("looks for claude.exe on Windows", () => {
    const resolved = Effect.runSync(
      resolve({ platform: "win32", env: { PATH: "C:\\bin" } }, "C:\\bin/claude.exe"),
    );

    expect(resolved).toContain("claude.exe");
  });

  it("fails with something the user can act on when nothing is installed", () => {
    const error = Effect.runSync(Effect.flip(resolve({ env: { PATH: "/usr/bin" } })));

    expect(error.message).toMatch(/Claude Code was not found.*VIBEST_CLAUDE_EXECUTABLE/s);
  });
});

describe("checkClaudeAvailability (version floor)", () => {
  /** A resolvable executable plus injectable version reader / floor. */
  function availDeps(overrides: AvailabilityDeps = {}): AvailabilityDeps {
    return {
      env: { VIBEST_CLAUDE_EXECUTABLE: "/bin/claude" },
      requiredVersion: () => Effect.succeed("2.1.216"),
      readVersion: async () => "2.1.216 (Claude Code)",
      ...overrides,
    };
  }

  /** The check reads the platform only through the resolver; a bare fake will do. */
  const check = (overrides: AvailabilityDeps = {}, ...installed: ReadonlyArray<string>) =>
    checkClaudeAvailability(availDeps(overrides)).pipe(
      Effect.provide(fakeExecutables(...installed)),
    );

  /** Unconditional reason extractor so assertions never sit behind an `if`. */
  const reasonOf = (result: AvailabilityResult): string => (result.available ? "" : result.reason);

  it.effect("is available when the CLI matches the floor", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* check(), { available: true });
    }),
  );

  it.effect("is available when the CLI is newer than the floor", () =>
    Effect.gen(function* () {
      const result = yield* check({ readVersion: async () => "2.1.218 (Claude Code)" });
      assert.deepEqual(result, { available: true });
    }),
  );

  it.effect("is unavailable with an actionable reason when the CLI is too old", () =>
    Effect.gen(function* () {
      const result = yield* check({ readVersion: async () => "2.1.215 (Claude Code)" });
      assert.equal(result.available, false);
      assert.match(reasonOf(result), /2\.1\.215 is too old/);
      assert.match(reasonOf(result), /2\.1\.216 or newer/);
      assert.ok(reasonOf(result).includes("claude.com/claude-code"));
    }),
  );

  it.effect("compares numerically, not lexically (2.1.9 < 2.1.216)", () =>
    Effect.gen(function* () {
      const result = yield* check({ readVersion: async () => "2.1.9 (Claude Code)" });
      assert.equal(result.available, false);
    }),
  );

  it.effect("fails OPEN when the version cannot be read", () =>
    Effect.gen(function* () {
      const result = yield* check({
        readVersion: async () => {
          throw new Error("spawn failed");
        },
      });
      assert.deepEqual(result, { available: true });
    }),
  );

  it.effect("fails OPEN when the version string is unparseable", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* check({ readVersion: async () => "unknown build" }), {
        available: true,
      });
    }),
  );

  it.effect("fails OPEN when the floor itself cannot be read", () =>
    Effect.gen(function* () {
      const result = yield* check({
        requiredVersion: () => Effect.fail(new Error("manifest missing claudeCodeVersion")),
        readVersion: async () => "1.0.0 (Claude Code)",
      });
      assert.deepEqual(result, { available: true });
    }),
  );

  it.effect("is unavailable with the resolve error when no binary is found", () =>
    Effect.gen(function* () {
      const result = yield* check({
        env: { PATH: "/usr/bin" },
        home: "/home/din",
        bundled: () => undefined,
      });
      assert.equal(result.available, false);
      assert.match(reasonOf(result), /Claude Code was not found/);
    }),
  );
});
