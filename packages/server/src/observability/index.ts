import { Crypto, Effect, Layer, Logger, References } from "effect";

import { Paths } from "../config/paths";
import * as Logging from "./logging";

/**
 * The process-owned local observability layer.
 *
 * FileSystem, Crypto, and Paths ride `R` and are bound at the composition
 * roots. Do not seal a Node platform layer in here — a second FileSystem
 * silently splits from the rest of the process. The log directory comes from
 * `Paths.logsDir`; there is no second way to name it.
 */
export function layer() {
  return Layer.unwrap(
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const { logsDir } = yield* Paths;
      yield* Logging.ensureLogsDirectory(logsDir);
      const runId = yield* crypto.randomUUIDv4.pipe(
        Effect.map((uuid) => uuid.slice(0, 8)),
        Effect.catchTag("PlatformError", (cause) =>
          Effect.die(new Error("invariant: platform RNG failed minting a log run id", { cause })),
        ),
      );
      return Logger.layer(Logging.loggers(logsDir, runId), { mergeWithExisting: false }).pipe(
        Layer.orDie,
        Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
      );
    }),
  );
}

/**
 * Replaces Effect's default stdout logger with a no-op. Tests that do not
 * write `$VIBEST_HOME/logs` still must not leak `Effect.log*` to stdout.
 * `layer()` uses `mergeWithExisting: false`, so providing it replaces this.
 */
export const discard = Logger.layer([Logger.make(() => {})], { mergeWithExisting: false });
