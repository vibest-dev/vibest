import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { Layer } from "effect";

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
