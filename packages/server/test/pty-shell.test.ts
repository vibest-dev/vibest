import { describe, expect, it } from "vitest";

import { defaultShell, ptyTitle } from "../src/pty/types";

describe("pty naming", () => {
  it("picks the platform login shell and titles from its basename", () => {
    expect(defaultShell("linux", { SHELL: "/bin/zsh" })).toBe("/bin/zsh");
    expect(defaultShell("linux", {})).toBe("/bin/bash");
    expect(defaultShell("win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" })).toBe(
      "C:\\Windows\\System32\\cmd.exe",
    );
    expect(ptyTitle("/bin/zsh", "abcd1234")).toBe("zsh abcd");
    expect(ptyTitle("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "ffff")).toBe(
      "powershell.exe ffff",
    );
  });
});
