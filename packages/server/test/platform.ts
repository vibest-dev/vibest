import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Context, type Crypto, Effect, type FileSystem, Layer, Scope } from "effect";

import * as Observability from "../src/observability";

/**
 * The real Node platform services, mirroring what `rpc/runtime.ts` provides,
 * plus `Observability.discard` so `Effect.log*` does not leak to stdout.
 * Tests that write `$VIBEST_HOME/logs` provide `Observability.layer()`, which
 * replaces this logger.
 */
export const NodePlatformLayer: Layer.Layer<FileSystem.FileSystem | Crypto.Crypto> = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeCrypto.layer,
  Observability.discard,
);

/** `CurrentLoggers` in a captured context, for Promise-shaped `createServer`. */
export const discardContext = (): Promise<Context.Context<never>> =>
  Effect.runPromise(
    Layer.build(Observability.discard).pipe(
      Effect.map((context) => Context.omit(Scope.Scope)(context)),
      Effect.scoped,
    ),
  );
