import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { type RunCommand, resolveLoginShellPath } from "./login-shell-path";

const FENCED = (path: string) => `__vibest_path_start__${path}__vibest_path_end__`;

function resolve(
  command: Parameters<typeof resolveLoginShellPath>[0],
  options: Parameters<typeof resolveLoginShellPath>[1],
) {
  return Effect.runPromise(resolveLoginShellPath(command, options));
}

describe("resolveLoginShellPath", () => {
  it("reads PATH via printenv, never by interpolating $PATH", async () => {
    const command = vi.fn<RunCommand>((_file, args) => {
      expect(args[1]).toContain("printenv PATH");
      expect(args[1]).not.toContain('"$PATH"');
      return Effect.succeed(FENCED("/opt/homebrew/bin:/usr/bin"));
    });

    await expect(
      resolve(command, { platform: "darwin", shell: "/opt/homebrew/bin/fish" }),
    ).resolves.toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("runs the probe through the interactive login shell", async () => {
    const command = vi.fn<RunCommand>(() => Effect.succeed(FENCED("/usr/bin")));

    await resolve(command, { platform: "darwin", shell: "/bin/zsh" });

    expect(command).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", expect.stringContaining("printenv PATH")],
      5000,
    );
  });

  it("falls back to launchctl on darwin when the shell probe fails", async () => {
    const command = vi.fn<RunCommand>((file) =>
      file === "/bin/launchctl"
        ? Effect.succeed("/from/launchctl:/usr/bin\n")
        : Effect.fail(new Error("nushell: unknown flag -ilc")),
    );

    await expect(
      resolve(command, { platform: "darwin", shell: "/opt/homebrew/bin/nu" }),
    ).resolves.toBe("/from/launchctl:/usr/bin");
  });

  it("falls back to launchctl when the shell probe yields an empty PATH", async () => {
    const command = vi.fn<RunCommand>((file) =>
      Effect.succeed(file === "/bin/launchctl" ? "/from/launchctl\n" : FENCED("")),
    );

    await expect(resolve(command, { platform: "darwin", shell: "/bin/zsh" })).resolves.toBe(
      "/from/launchctl",
    );
  });

  it("does not try launchctl on linux", async () => {
    const command = vi.fn<RunCommand>(() => Effect.fail(new Error("shell exploded")));

    await expect(
      resolve(command, { platform: "linux", shell: "/bin/bash" }),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on Windows without spawning anything", async () => {
    const command = vi.fn<RunCommand>(() => Effect.succeed(FENCED("/whatever")));

    await expect(
      resolve(command, { platform: "win32", shell: undefined }),
    ).resolves.toBeUndefined();
    expect(command).not.toHaveBeenCalled();
  });

  it("returns undefined when both probes fail", async () => {
    const command = vi.fn<RunCommand>(() => Effect.fail(new Error("nope")));

    await expect(
      resolve(command, { platform: "darwin", shell: "/bin/zsh" }),
    ).resolves.toBeUndefined();
  });
});
