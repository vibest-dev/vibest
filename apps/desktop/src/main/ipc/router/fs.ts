import { implement } from "@orpc/server";
import { execFile, spawn } from "node:child_process";
import { dialog, shell } from "electron";

import type { AppContext } from "../../app";

import { fsContract } from "../../../shared/contract";

const os = implement(fsContract).$context<AppContext>();

export const selectDir = os.selectDir.handler(async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return "";
  }

  return result.filePaths[0];
});

export const openTerminal = os.openTerminal.handler(async ({ input }) => {
  const { path } = input;

  // macOS: open Terminal app
  if (process.platform === "darwin") {
    execFile("open", ["-a", "Terminal", path]);
  }
  // Windows: open cmd in specified directory
  else if (process.platform === "win32") {
    spawn("cmd.exe", ["/K", `cd /d "${path}"`], {
      shell: false,
      cwd: path,
      detached: true,
      stdio: "ignore",
    }).unref();
  }
  // Linux: try common terminal emulators
  else {
    const terminals = [
      { cmd: "x-terminal-emulator", args: ["--working-directory", path] },
      { cmd: "gnome-terminal", args: ["--working-directory", path] },
      { cmd: "konsole", args: ["--workdir", path] },
    ];

    for (const { cmd, args } of terminals) {
      try {
        const child = spawn(cmd, args, {
          detached: true,
          stdio: "ignore",
        });
        child.unref();
        break;
      } catch {
        continue;
      }
    }
  }
});

export const openFinder = os.openFinder.handler(async ({ input }) => {
  const { path } = input;
  await shell.openPath(path);
});

export const openInVSCode = os.openInVSCode.handler(async ({ input }) => {
  const { path } = input;

  if (process.platform === "darwin") {
    execFile("code", [path]);
  } else if (process.platform === "win32") {
    execFile("code", [path], { shell: true });
  } else {
    execFile("code", [path]);
  }
});

export const openInCursor = os.openInCursor.handler(async ({ input }) => {
  const { path } = input;

  if (process.platform === "darwin") {
    execFile("cursor", [path]);
  } else if (process.platform === "win32") {
    execFile("cursor", [path], { shell: true });
  } else {
    execFile("cursor", [path]);
  }
});

export const fsRouter = os.router({
  selectDir,
  openTerminal,
  openFinder,
  openInVSCode,
  openInCursor,
});
