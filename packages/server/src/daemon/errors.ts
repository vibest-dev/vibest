import { Schema } from "effect";

/** Failure while attaching or spawning the daemon: lock, port, spawn, readiness. */
export class DaemonLaunchError extends Schema.TaggedErrorClass<DaemonLaunchError>()(
  "Daemon.LaunchError",
  {
    message: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {}

/**
 * The user explicitly stopped the daemon (`daemon.stopped` tombstone present):
 * auto-respawn callers must not undo that. An explicit start clears it.
 */
export class DaemonStoppedError extends Schema.TaggedErrorClass<DaemonStoppedError>()(
  "Daemon.Stopped",
  {
    message: Schema.String,
  },
) {}
