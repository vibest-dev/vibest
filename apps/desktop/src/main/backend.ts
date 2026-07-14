import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseReadyLine } from "@vibest/cli/handshake";
import { app } from "electron";

import { loginShellPath } from "./shell-path";

const START_TIMEOUT_MS = 30_000;

export type StartBackendOptions = {
  /** Origins the renderer will call from: the app protocol, and the dev server. */
  corsOrigins: readonly string[];
};

export type Backend = {
  httpBaseUrl: string;
  wsBaseUrl: string;
  /** Per-launch bearer token. Held in memory only. */
  token: string;
  stop(): void;
};

/**
 * Where the server bundle lives. `@vibest/cli` is a production dependency of
 * this app, so electron-builder collects it — and its whole dependency tree,
 * correctly flattened out of pnpm's store — into the asar. The bundle is not
 * self-contained (the Claude Agent SDK resolves its own files relative to its
 * package directory, so it cannot be inlined), which is why the server is
 * spawned from that collected tree rather than copied out of it. Electron's
 * Node reads asar paths transparently, including under ELECTRON_RUN_AS_NODE.
 * Unpackaged runs use the monorepo's build output.
 */
export function resolveServerEntry(isPackaged: boolean, resourcesPath: string): string {
  if (isPackaged) {
    return path.join(
      resourcesPath,
      "app.asar",
      "node_modules",
      "@vibest",
      "cli",
      "dist",
      "cli.mjs",
    );
  }
  return fileURLToPath(new URL("../../../../packages/vibest/dist/cli.mjs", import.meta.url));
}

/**
 * Spawn the vibest server and wait for it to report the port it bound.
 *
 * It runs on Electron's own Node runtime (`process.execPath` +
 * ELECTRON_RUN_AS_NODE), so a packaged app needs no Node installed. It binds a
 * random loopback port, so two launches never collide, and it is guarded by a
 * token minted here and never written to disk.
 */
export async function startBackend(options: StartBackendOptions): Promise<Backend> {
  const token = randomUUID();
  const entry = resolveServerEntry(app.isPackaged, process.resourcesPath);

  // The server has to exec the user's `claude`, so it needs the PATH the user's
  // terminal has — not the one launchd hands a GUI app. Only the packaged app
  // is launched that way; `pnpm dev` already inherits a good PATH.
  const shellPath = app.isPackaged ? await loginShellPath() : undefined;

  const child: ChildProcess = spawn(process.execPath, [entry], {
    env: {
      ...process.env,
      ...(shellPath ? { PATH: shellPath } : {}),
      ELECTRON_RUN_AS_NODE: "1",
      VIBEST_AUTH_TOKEN: token,
      VIBEST_PORT: "0",
      VIBEST_CORS_ORIGINS: options.corsOrigins.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[vibest-server] ${chunk.toString().trimEnd()}`);
  });

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Backend did not report ready within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);

    const settleError = (error: Error) => {
      clearTimeout(timer);
      reject(error);
    };

    child.once("error", settleError);
    child.once("exit", (code) => {
      settleError(new Error(`Backend exited during startup with code ${code}`));
    });

    if (!child.stdout) {
      settleError(new Error("Backend stdout is not readable"));
      return;
    }

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const ready = parseReadyLine(line);
      if (!ready) {
        console.log(`[vibest-server] ${line}`);
        return;
      }
      clearTimeout(timer);
      child.removeListener("error", settleError);
      child.removeAllListeners("exit");
      resolve(ready.port);
    });
  });

  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    token,
    stop() {
      child.kill();
    },
  };
}
