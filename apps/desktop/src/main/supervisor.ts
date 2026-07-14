/**
 * Keeps the backend process alive for the session.
 *
 * The first start is fatal if it fails — the caller shows a dialog and quits.
 * After that, an unexpected exit is treated as a crash and the server is
 * restarted on the *same* pinned port with exponential backoff. A run that stays
 * up long enough is considered healthy and resets the failure count; too many
 * failures in a row gives up in a terminal "failed" state rather than looping
 * forever. Status transitions are pushed to the renderer, which reflects them as
 * a reconnecting banner (see the IPC wiring in index.ts).
 *
 * The state machine is separated from real process spawning (backend.ts) so its
 * timing and restart logic can be tested with an injected spawn and clock.
 */

import type { BackendStatus } from "../shared/bridge";

export type { BackendStatus };

/** One spawned server process, abstracted so the supervisor never touches Node's child_process. */
export type ServerProcess = {
  /** Resolves with the bound port once ready; rejects if it exits or times out first. */
  ready: Promise<number>;
  /** Registers a one-shot exit listener. Fires once, for any exit reason. */
  onExit: (listener: () => void) => void;
  /** Terminate the process. */
  kill: () => void;
};

/** Spawns a server bound to `port` (0 = let the OS choose, only used for the first start). */
export type SpawnServer = (port: number) => ServerProcess;

export type SupervisorOptions = {
  spawn: SpawnServer;
  onStatus?: (status: BackendStatus) => void;
  /** Injected for tests; defaults to real timers/clock. */
  delay?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Backoff floor, doubled each consecutive failure. */
  initialRestartDelayMs?: number;
  /** Backoff ceiling. */
  maxRestartDelayMs?: number;
  /** Consecutive fast failures tolerated before giving up. */
  maxFastFailures?: number;
  /** A run that stays up at least this long is "healthy" and resets the failure count. */
  stableAfterMs?: number;
};

export type BackendSupervisor = {
  /** Start the first server. Resolves with the pinned port, or rejects if the first start fails. */
  start: () => Promise<number>;
  /** Manually clear a `failed` state and try again (the renderer's "Retry"). */
  retry: () => void;
  /** Stop supervising and kill the current server. No further restarts. */
  stop: () => void;
  status: () => BackendStatus;
};

const DEFAULTS = {
  initialRestartDelayMs: 500,
  maxRestartDelayMs: 10_000,
  maxFastFailures: 5,
  stableAfterMs: 10_000,
};

export function createSupervisor(options: SupervisorOptions): BackendSupervisor {
  const spawn = options.spawn;
  const emit = options.onStatus ?? (() => {});
  const delay = options.delay ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const initialDelay = options.initialRestartDelayMs ?? DEFAULTS.initialRestartDelayMs;
  const maxDelay = options.maxRestartDelayMs ?? DEFAULTS.maxRestartDelayMs;
  const maxFailures = options.maxFastFailures ?? DEFAULTS.maxFastFailures;
  const stableAfter = options.stableAfterMs ?? DEFAULTS.stableAfterMs;

  let status: BackendStatus = "starting";
  let pinnedPort = 0;
  let current: ServerProcess | undefined;
  let stopped = false;
  // Restarts only arm after the first successful start, so a failed first start
  // stays fatal (the caller quits) instead of entering the restart loop.
  let supervising = false;
  let fastFailures = 0;

  function setStatus(next: BackendStatus): void {
    if (status === next) return;
    status = next;
    emit(next);
  }

  function backoff(failureCount: number): number {
    return Math.min(initialDelay * 2 ** (failureCount - 1), maxDelay);
  }

  /** Spawn one process on `port` and wire its exit into the restart loop. */
  function launch(port: number): Promise<number> {
    const proc = spawn(port);
    current = proc;
    const startedAt = now();
    let becameReady = false;

    proc.onExit(() => {
      if (stopped || !supervising || status === "failed" || proc !== current) return;
      // A run that never became ready has, by definition, zero healthy uptime.
      scheduleRestart(becameReady ? now() - startedAt : 0);
    });

    return proc.ready.then((boundPort) => {
      becameReady = true;
      return boundPort;
    });
  }

  function scheduleRestart(uptimeMs: number): void {
    if (uptimeMs >= stableAfter) fastFailures = 0;
    fastFailures += 1;

    if (fastFailures > maxFailures) {
      setStatus("failed");
      return;
    }

    setStatus("reconnecting");
    void delay(backoff(fastFailures)).then(() => {
      if (stopped || status === "failed") return;
      launch(pinnedPort).then(
        () => {
          if (!stopped && status !== "failed") setStatus("ready");
        },
        () => {
          // Exited before ready; its own onExit already scheduled the next try.
        },
      );
    });
  }

  return {
    async start() {
      setStatus("starting");
      const port = await launch(0);
      pinnedPort = port;
      supervising = true;
      setStatus("ready");
      return port;
    },

    retry() {
      if (status !== "failed" || stopped) return;
      fastFailures = 0;
      setStatus("reconnecting");
      launch(pinnedPort).then(
        () => {
          if (!stopped && status !== "failed") setStatus("ready");
        },
        () => {},
      );
    },

    stop() {
      stopped = true;
      current?.kill();
      current = undefined;
    },

    status() {
      return status;
    },
  };
}
