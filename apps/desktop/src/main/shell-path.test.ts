import { describe, expect, it, vi } from "vitest";

import { type Exec, loginShellPath } from "./shell-path";

const FENCED = (path: string) => ({
  stdout: `__vibest_path_start__${path}__vibest_path_end__`,
});

describe("loginShellPath", () => {
  it("reads PATH via `printenv`, never by interpolating $PATH", async () => {
    const exec = vi.fn<Exec>(async (_file, args) => {
      const command = args[1] ?? "";
      // The whole point of the fix: fish stores $PATH space-delimited, so the
      // value must come from the external `printenv`, not a "$PATH" expansion.
      expect(command).toContain("printenv PATH");
      expect(command).not.toContain('"$PATH"');
      return FENCED("/opt/homebrew/bin:/usr/bin");
    });

    const path = await loginShellPath({
      exec,
      platform: "darwin",
      shell: "/opt/homebrew/bin/fish",
    });

    expect(path).toBe("/opt/homebrew/bin:/usr/bin");
  });

  it("runs the probe through the interactive login shell", async () => {
    const exec = vi.fn<Exec>(async () => FENCED("/usr/bin"));

    await loginShellPath({ exec, platform: "darwin", shell: "/bin/zsh" });

    expect(exec).toHaveBeenCalledWith(
      "/bin/zsh",
      ["-ilc", expect.stringContaining("printenv PATH")],
      expect.objectContaining({ timeout: 5000 }),
    );
  });

  it("falls back to launchctl on darwin when the shell probe throws", async () => {
    const exec = vi.fn<Exec>(async (file) => {
      if (file === "/bin/launchctl") return { stdout: "/from/launchctl:/usr/bin\n" };
      throw new Error("nushell: unknown flag -ilc");
    });

    const path = await loginShellPath({ exec, platform: "darwin", shell: "/opt/homebrew/bin/nu" });

    expect(path).toBe("/from/launchctl:/usr/bin");
  });

  it("falls back to launchctl when the shell probe yields an empty PATH", async () => {
    const exec = vi.fn<Exec>(async (file) => {
      if (file === "/bin/launchctl") return { stdout: "/from/launchctl\n" };
      return FENCED(""); // e.g. a slow rc that never exported PATH before the fence
    });

    const path = await loginShellPath({ exec, platform: "darwin", shell: "/bin/zsh" });

    expect(path).toBe("/from/launchctl");
  });

  it("does not try launchctl on linux (no launchd)", async () => {
    const exec = vi.fn<Exec>(async () => {
      throw new Error("shell exploded");
    });

    const path = await loginShellPath({ exec, platform: "linux", shell: "/bin/bash" });

    expect(path).toBeUndefined();
    // Only the shell probe was attempted, never launchctl.
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on Windows without spawning anything", async () => {
    const exec = vi.fn<Exec>(async () => FENCED("/whatever"));

    const path = await loginShellPath({ exec, platform: "win32", shell: undefined });

    expect(path).toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns undefined when both the shell and launchctl fail", async () => {
    const exec = vi.fn<Exec>(async () => {
      throw new Error("nope");
    });

    const path = await loginShellPath({ exec, platform: "darwin", shell: "/bin/zsh" });

    expect(path).toBeUndefined();
  });
});
