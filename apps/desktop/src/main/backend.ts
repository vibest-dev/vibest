import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { parseReadyLine } from "@vibest/cli/handshake";
import { app } from "electron";

import { loginShellPath } from "./shell-path";
import { type BackendStatus, type ServerProcess, createSupervisor } from "./supervisor";

const START_TIMEOUT_MS = 30_000;

export type StartBackendOptions = {
  /** Origins the renderer will call from: the app protocol, and the dev server. */
  corsOrigins: readonly string[];
};

export type Backend = {
  httpBaseUrl: string;
  wsBaseUrl: string;
  /** Per-session bearer token. Held in memory only, stable across restarts. */
  token: string;
  /** Current supervision status, for the renderer's reconnecting UI. */
  status: () => BackendStatus;
  /** Subscribe to status transitions (crash → reconnecting → ready, or failed). */
  onStatusChange: (listener: (status: BackendStatus) => void) => void;
  /** Clear a failed state and try to bring the backend back (the renderer's "Retry"). */
  retry: () => void;
  stop: () => void;
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

type SpawnConfig = {
  entry: string;
  token: string;
  shellPath: string | undefined;
  corsOrigins: readonly string[];
};

/**
 * Spawn one server process bound to `port` (0 = OS-assigned, first start only).
 *
 * It runs on Electron's own Node runtime (`process.execPath` +
 * ELECTRON_RUN_AS_NODE), so a packaged app needs no Node installed. `ready`
 * resolves with the port it reports on stdout; an early exit, spawn error, or
 * timeout rejects it (and the supervisor treats the exit as a crash to retry).
 */
function spawnServer(config: SpawnConfig, port: number): ServerProcess {
  const child: ChildProcess = spawn(process.execPath, [config.entry], {
    env: {
      ...process.env,
      ...(config.shellPath ? { PATH: config.shellPath } : {}),
      ELECTRON_RUN_AS_NODE: "1",
      VIBEST_AUTH_TOKEN: config.token,
      VIBEST_PORT: String(port),
      VIBEST_CORS_ORIGINS: config.corsOrigins.join(","),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    console.error(`[vibest-server] ${chunk.toString().trimEnd()}`);
  });

  const ready = new Promise<number>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() => {
        child.kill();
        reject(new Error(`Backend did not report ready within ${START_TIMEOUT_MS}ms`));
      });
    }, START_TIMEOUT_MS);

    child.once("error", (error) => settle(() => reject(error)));
    child.once("exit", (code) =>
      settle(() => reject(new Error(`Backend exited during startup with code ${code}`))),
    );

    if (!child.stdout) {
      settle(() => reject(new Error("Backend stdout is not readable")));
      return;
    }

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const parsed = parseReadyLine(line);
      if (!parsed) {
        console.log(`[vibest-server] ${line}`);
        return;
      }
      settle(() => resolve(parsed.port));
    });
  });

  return {
    ready,
    onExit: (listener) => {
      let fired = false;
      const fire = () => {
        if (fired) return;
        fired = true;
        listener();
      };
      // 'error' covers a spawn that never produces an 'exit' (e.g. bad execPath).
      child.once("exit", fire);
      child.once("error", fire);
    },
    kill: () => child.kill(),
  };
}

/**
 * Start the vibest server and supervise it for the session.
 *
 * The first start is awaited; if it fails the promise rejects and the caller
 * quits. After that the server is kept alive: an unexpected exit restarts it on
 * the *same* port with the *same* token (both pinned here), so the renderer's
 * existing clients transparently reconnect. See {@link createSupervisor}.
 */
export async function startBackend(options: StartBackendOptions): Promise<Backend> {
  // Minted once and reused on every restart, so the renderer's clients keep
  // working across a backend crash without re-bootstrapping.
  const token = randomUUID();
  const entry = resolveServerEntry(app.isPackaged, process.resourcesPath);

  // The server has to exec the user's `claude`, so it needs the PATH the user's
  // terminal has — not the one launchd hands a GUI app. Probed once; restarts
  // reuse it. Only the packaged app is launched that way; `pnpm dev` already
  // inherits a good PATH.
  const shellPath = app.isPackaged ? await loginShellPath() : undefined;

  const config: SpawnConfig = { entry, token, shellPath, corsOrigins: options.corsOrigins };
  const listeners = new Set<(status: BackendStatus) => void>();

  const supervisor = createSupervisor({
    spawn: (port) => spawnServer(config, port),
    onStatus: (status) => {
      for (const listener of listeners) listener(status);
    },
  });

  const port = await supervisor.start();

  return {
    httpBaseUrl: `http://127.0.0.1:${port}`,
    wsBaseUrl: `ws://127.0.0.1:${port}`,
    token,
    status: supervisor.status,
    onStatusChange: (listener) => {
      listeners.add(listener);
    },
    retry: supervisor.retry,
    stop: supervisor.stop,
  };
}
