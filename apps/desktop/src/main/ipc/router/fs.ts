import { implement } from "@orpc/server";
import { exec } from "child_process";
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
    exec(`open -a Terminal "${path}"`);
  }
  // Windows: open cmd
  else if (process.platform === "win32") {
    exec(`start cmd /K "cd /d ${path}"`);
  }
  // Linux: try common terminal emulators
  else {
    exec(
      `x-terminal-emulator --working-directory="${path}" || gnome-terminal --working-directory="${path}" || konsole --workdir "${path}"`,
    );
  }
});

export const openFinder = os.openFinder.handler(async ({ input }) => {
  const { path } = input;
  await shell.openPath(path);
});

export const fsRouter = os.router({
  selectDir,
  openTerminal,
  openFinder,
});
