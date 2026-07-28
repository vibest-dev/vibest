import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as NodePath from "@effect/platform-node/NodePath";
import { Layer } from "effect";

import type { JsonStorePlatform } from "../src/infra/json-store";

/**
 * The real Node platform services, mirroring what `rpc/runtime.ts` provides.
 * Tests that exercise a repository against a temp `$VIBEST_HOME` provide this
 * so the JSON store's `FileSystem | Path | Crypto` requirement is satisfied.
 */
export const NodePlatformLayer: Layer.Layer<JsonStorePlatform> = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeCrypto.layer,
);
