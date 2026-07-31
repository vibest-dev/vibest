import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, type Scope } from "effect";

import type { JsonStorePlatform } from "../src/infra/json-store";

/**
 * The real Node platform services, mirroring what `rpc/runtime.ts` provides.
 * Tests that exercise a repository against a temp `$VIBEST_HOME` provide this
 * so the JSON store's `FileSystem | Crypto` requirement is satisfied.
 */
export const NodePlatformLayer: Layer.Layer<JsonStorePlatform> = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeCrypto.layer,
);

/**
 * Run one effect on the full Node platform, exactly as the CLI and the desktop
 * provide it. For Promise-shaped tests (`vitest`'s plain `it` plus
 * `beforeEach`/`afterEach`); a test file whose bodies are all effects should
 * reach for `@effect/vitest`'s `layer(...)` and its scoped `it.effect` instead
 * — see `harness/child-process.test.ts`.
 *
 * Lives here rather than in each test file so "provide the real platform" has
 * one spelling.
 */
export const runNode = <A, E>(
  effect: Effect.Effect<A, E, NodeServices.NodeServices | Scope.Scope>,
): Promise<A> => Effect.runPromise(effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
