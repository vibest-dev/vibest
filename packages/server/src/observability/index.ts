import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Layer, Logger, References } from "effect";

import * as Logging from "./logging";

export type Options = {
  /** Directory containing the process log. Defaults to `$VIBEST_HOME/logs`. */
  readonly directory?: string;
};

/** The process-owned local observability layer. */
export function layer(options: Options = {}) {
  return Logger.layer(Logging.loggers(options.directory), { mergeWithExisting: false }).pipe(
    Layer.provide(NodeFileSystem.layer),
    Layer.orDie,
    Layer.merge(Layer.succeed(References.MinimumLogLevel, Logging.minimumLogLevel())),
  );
}

export { Logging };
