import * as NodePath from "@effect/platform-node/NodePath";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";

import {
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
  resolveClaudeExecutable(deps(overrides)).pipe(
    Effect.provide(Layer.merge(fakeExecutables(...installed), NodePath.layer)),
  );

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
