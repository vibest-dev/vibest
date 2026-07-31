import { createRouterClient } from "@orpc/server";
import { Layer, ManagedRuntime } from "effect";

import { layerPaths } from "../src/config/paths";
import {
  HarnessAgentRegistry,
  makeHarnessAgentRegistry,
  type HarnessAgentAdapter,
} from "../src/harness";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import { makeAgentRuntimeLayer } from "../src/rpc/runtime";
import { NodePlatformLayer } from "./platform";

/**
 * A router client backed by the full `RpcContext`, built through the
 * production composition shape (`makeAgentRuntimeLayer`) with project storage
 * under `home` — so every test that goes through here exercises the same
 * one-bus / one-registry wiring the server runs. Pass `registry` to observe or
 * instrument the registry layer itself (see runtime-composition.test.ts);
 * otherwise `adapters` becomes a plain in-memory registry.
 */
export async function makeRpcTestHarness(
  home: string,
  adapters: ReadonlyArray<HarnessAgentAdapter> = [],
  registry?: Layer.Layer<HarnessAgentRegistry>,
) {
  const runtime = ManagedRuntime.make(
    makeAgentRuntimeLayer({
      registry:
        registry ?? Layer.sync(HarnessAgentRegistry, () => makeHarnessAgentRegistry(adapters)),
      paths: layerPaths(home),
      platform: NodePlatformLayer,
    }),
  );
  // Layer construction does file I/O now (the project document loads eagerly),
  // so the context must be built asynchronously.
  const context: RpcContext = {
    "effect/context": await runtime.runPromise(runtime.contextEffect),
  };
  return {
    client: createRouterClient(router, { context }),
    dispose: () => runtime.dispose(),
  };
}
