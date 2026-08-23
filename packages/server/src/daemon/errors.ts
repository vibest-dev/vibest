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

/**
 * `stopDaemon` could not take the lifecycle locks before its deadline. Stopping
 * has to be bounded: a launcher wedged mid-publish (or a lock leaked by a
 * killed one) would otherwise hang `vibest daemon stop` forever with nothing to
 * report. The tombstone is already written when this fails, so a retry after
 * the holder releases is the whole recovery.
 */
export class DaemonStopError extends Data.TaggedError("DaemonStopError")<{
  readonly message: string;
}> {}
