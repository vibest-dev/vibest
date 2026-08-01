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
 * one-bus / one-registry wiring the server runs. `registry` is either the
 * adapters for a plain in-memory registry, or a whole registry Layer for tests
 * that instrument the layer itself (see runtime-composition.test.ts) — one
 * parameter, so the two can never conflict.
 */
type RegistryInput = ReadonlyArray<HarnessAgentAdapter> | Layer.Layer<HarnessAgentRegistry>;

// `Array.isArray` alone can't split this union (readonly arrays don't narrow
// against `any[]`), so spell the predicate out once.
const isAdapterList = (value: RegistryInput): value is ReadonlyArray<HarnessAgentAdapter> =>
  Array.isArray(value);

export async function makeRpcTestHarness(home: string, registry: RegistryInput = []) {
  const registryLayer = isAdapterList(registry)
    ? Layer.sync(HarnessAgentRegistry, () => makeHarnessAgentRegistry(registry))
    : registry;
  const runtime = ManagedRuntime.make(
    makeAgentRuntimeLayer({
      registry: registryLayer,
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
