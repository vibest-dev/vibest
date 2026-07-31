import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { type Crypto, type FileSystem, Layer } from "effect";

/**
 * The real Node platform services, mirroring what `rpc/runtime.ts` provides.
 * Tests that exercise a repository against a temp `$VIBEST_HOME` provide this
 * so the repositories' `FileSystem | Crypto` requirement is satisfied.
 */
export const NodePlatformLayer: Layer.Layer<FileSystem.FileSystem | Crypto.Crypto> = Layer.mergeAll(
  NodeFileSystem.layer,
  NodeCrypto.layer,
);
