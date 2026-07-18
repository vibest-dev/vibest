import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { createRouterClient } from "@orpc/server";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionServiceLayer,
  makeHarnessAgentRegistry,
} from "@vibest/harness/runtime";
import { Layer, ManagedRuntime } from "effect";

import { layerPaths } from "../src/config/paths";
import { EventBusLayer } from "../src/events";
import { ProjectModuleLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";

/**
 * A router client backed by the full `RpcContext`, with an adapterless session
 * service and project storage under `home`. Tests that need live adapters
 * (rpc-session) build their own layers instead.
 */
export function makeRpcTestHarness(home: string) {
  const sessionLayer = HarnessAgentSessionServiceLayer.pipe(
    Layer.provide(Layer.sync(HarnessAgentRegistry, () => makeHarnessAgentRegistry([]))),
    Layer.provide(EventBusLayer),
  );
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      EventBusLayer,
      sessionLayer,
      ProjectModuleLayer.pipe(Layer.provide(layerPaths(home))),
      NodeFileSystem.layer,
    ),
  );
  const context: RpcContext = {
    "effect/context": runtime.runSync(runtime.contextEffect),
  };
  return {
    client: createRouterClient(router, { context }),
    dispose: () => runtime.dispose(),
  };
}
