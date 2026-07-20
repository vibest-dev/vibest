import { Data } from "effect";

/** Failure while attaching or spawning the daemon: lock, port, spawn, readiness. */
export class DaemonLaunchError extends Data.TaggedError("DaemonLaunchError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * The user explicitly stopped the daemon (`daemon.stopped` tombstone present):
 * auto-respawn callers must not undo that. An explicit start clears it.
 */
export class DaemonStoppedError extends Data.TaggedError("DaemonStoppedError")<{
  readonly message: string;
}> {}
