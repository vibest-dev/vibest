import { createRouterClient } from "@orpc/server";
import { Layer, ManagedRuntime } from "effect";

import { layerPaths } from "../src/config/paths";
import { EventBusLayer } from "../src/events";
import { FileSystemServiceLayer } from "../src/fs";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionManagerLayer,
  HarnessAgentSessionServiceLayer,
  HarnessListLayer,
  HarnessProbeLayer,
  makeHarnessAgentRegistry,
  type HarnessAgentAdapter,
} from "../src/harness";
import { ProjectModuleLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import { NodePlatformLayer } from "./platform";

/**
 * A router client backed by the full `RpcContext`, with an adapterless session
 * service and project storage under `home`. Tests that need live adapters
 * (rpc-session) build their own layers instead.
 */
export async function makeRpcTestHarness(
  home: string,
  adapters: ReadonlyArray<HarnessAgentAdapter> = [],
) {
  // Paths plus the platform services the repositories' JSON store runs on.
  const paths = Layer.provideMerge(layerPaths(home), NodePlatformLayer);
  const registryLayer = Layer.sync(HarnessAgentRegistry, () => makeHarnessAgentRegistry(adapters));
  // EventBusLayer is one reference so publish (manager/service) and subscribe
  // (RPC) share the single bus instance; same for registryLayer.
  const harnessSessionLayer = HarnessAgentSessionServiceLayer.pipe(
    Layer.provide(
      HarnessAgentSessionManagerLayer.pipe(
        Layer.provide(registryLayer),
        Layer.provide(EventBusLayer),
        Layer.provide(NodePlatformLayer),
      ),
    ),
    Layer.provide(registryLayer),
    Layer.provide(EventBusLayer),
    Layer.provide(paths),
    Layer.provide(NodePlatformLayer),
  );
  const listLayer = HarnessListLayer.pipe(
    Layer.provide(registryLayer),
    Layer.provide(NodePlatformLayer),
  );
  const probeLayer = HarnessProbeLayer.pipe(Layer.provide(registryLayer));
  const projectLayer = ProjectModuleLayer.pipe(Layer.provide(paths));
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      EventBusLayer,
      harnessSessionLayer,
      projectLayer,
      registryLayer,
      listLayer,
      probeLayer,
      FileSystemServiceLayer.pipe(Layer.provide(NodePlatformLayer)),
      NodePlatformLayer,
    ),
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
