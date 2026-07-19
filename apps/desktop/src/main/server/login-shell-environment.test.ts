import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { type RunCommand, resolveLoginShellEnvironment } from "./login-shell-environment";

function fenced(environment: NodeJS.ProcessEnv, noise = "") {
  const entries = Object.entries(environment)
    .map(([key, value]) => `${key}=${value ?? ""}`)
    .join("\0");
  return `${noise}\0__vibest_env_start__\0${entries}\0__vibest_env_end__\0`;
}

function resolve(
  command: Parameters<typeof resolveLoginShellEnvironment>[0],
  options: Parameters<typeof resolveLoginShellEnvironment>[1],
) {
  return Effect.runPromise(resolveLoginShellEnvironment(command, options));
}

describe("resolveLoginShellEnvironment", () => {
  it("reads all exported variables from the interactive login shell", async () => {
    const command = vi.fn<RunCommand>((_file, args) => {
      expect(args[1]).toContain("/usr/bin/env -0");
      return Effect.succeed(
        fenced(
          {
            PATH: "/opt/homebrew/bin:/usr/bin",
            HTTPS_PROXY: "http://proxy.test:8443",
          },
          "shell banner\n",
        ),
      );
    });

    await expect(
      resolve(command, {
        platform: "darwin",
        shell: "/opt/homebrew/bin/fish",
        baseEnv: { HOME: "/Users/test", PATH: "/usr/bin" },
      }),
    ).resolves.toEqual({
      HOME: "/Users/test",
      PATH: "/opt/homebrew/bin:/usr/bin",
      HTTPS_PROXY: "http://proxy.test:8443",
    });
  });

  it("runs the environment probe through the interactive login shell", async () => {
    const command = vi.fn<RunCommand>(() => Effect.succeed(fenced({ PATH: "/usr/bin" })));

    await resolve(command, {
      platform: "darwin",
      shell: "/bin/zsh",
      baseEnv: {},
    });

    expect(command).toHaveBeenCalledWith("/bin/zsh", [
      "-ilc",
      expect.stringContaining("/usr/bin/env -0"),
    ]);
  });

  it("keeps launch-time VIBEST_* variables over login-shell exports", async () => {
    const command = vi.fn<RunCommand>(() =>
      Effect.succeed(fenced({ PATH: "/opt/homebrew/bin", VIBEST_HOME: "/Users/test/.vibest" })),
    );

    await expect(
      resolve(command, {
        platform: "darwin",
        shell: "/bin/zsh",
        baseEnv: { PATH: "/usr/bin", VIBEST_HOME: "/tmp/switched-home" },
      }),
    ).resolves.toEqual({
      PATH: "/opt/homebrew/bin",
      VIBEST_HOME: "/tmp/switched-home",
    });
  });

  it("falls back to launchctl for PATH and proxy variables on darwin", async () => {
    const command = vi.fn<RunCommand>((file, args) => {
      if (file !== "/bin/launchctl") return Effect.fail(new Error("shell failed"));
      const values: Record<string, string> = {
        PATH: "/from/launchctl:/usr/bin",
        HTTPS_PROXY: "http://launchctl-proxy.test:8443",
      };
      return Effect.succeed(`${values[args[1]!] ?? ""}\n`);
    });

    await expect(
      resolve(command, {
        platform: "darwin",
        shell: "/opt/homebrew/bin/nu",
        baseEnv: { HOME: "/Users/test" },
      }),
    ).resolves.toMatchObject({
      HOME: "/Users/test",
      PATH: "/from/launchctl:/usr/bin",
      HTTPS_PROXY: "http://launchctl-proxy.test:8443",
    });
  });

  it("preserves values containing equals signs", async () => {
    const command = vi.fn<RunCommand>(() =>
      Effect.succeed(fenced({ HTTPS_PROXY: "http://user:token=a@proxy.test:8443" })),
    );

    await expect(
      resolve(command, { platform: "linux", shell: "/bin/bash", baseEnv: {} }),
    ).resolves.toMatchObject({
      HTTPS_PROXY: "http://user:token=a@proxy.test:8443",
    });
  });

  it("uses the inherited environment when the shell probe fails on linux", async () => {
    const command = vi.fn<RunCommand>(() => Effect.fail(new Error("shell exploded")));

    await expect(
      resolve(command, {
        platform: "linux",
        shell: "/bin/bash",
        baseEnv: { HTTPS_PROXY: "http://inherited.test:8080" },
      }),
    ).resolves.toEqual({ HTTPS_PROXY: "http://inherited.test:8080" });
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("returns the inherited environment on Windows without spawning anything", async () => {
    const command = vi.fn<RunCommand>(() => Effect.succeed(fenced({ PATH: "/whatever" })));

    await expect(
      resolve(command, {
        platform: "win32",
        shell: undefined,
        baseEnv: { HTTPS_PROXY: "http://windows-proxy.test:8080" },
      }),
    ).resolves.toEqual({ HTTPS_PROXY: "http://windows-proxy.test:8080" });
    expect(command).not.toHaveBeenCalled();
  });

  it("keeps the inherited environment when every darwin probe fails", async () => {
    const command = vi.fn<RunCommand>(() => Effect.fail(new Error("nope")));

    await expect(
      resolve(command, {
        platform: "darwin",
        shell: "/bin/zsh",
        baseEnv: { HOME: "/Users/test" },
      }),
    ).resolves.toEqual({ HOME: "/Users/test" });
  });
});
