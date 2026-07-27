import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { createRouterClient } from "@orpc/server";
import { Layer, ManagedRuntime } from "effect";

import { layerPaths } from "../src/config/paths";
import { EventBusLayer } from "../src/events";
import { FileSystemServiceLayer } from "../src/fs";
import {
  HarnessAgentRegistry,
  HarnessAgentSessionServiceLayer,
  HarnessListLayer,
  HarnessProbeLayer,
  makeHarnessAgentRegistry,
  type HarnessAgentAdapter,
} from "../src/harness";
import { ProjectModuleLayer } from "../src/project";
import type { RpcContext } from "../src/rpc/context";
import { router } from "../src/rpc/router";
import {
  HarnessAgentSessionPortLayer,
  SessionManagerLayer,
  SessionRepositoryLayer,
  SessionServiceLayer,
} from "../src/session";

/**
 * A router client backed by the full `RpcContext`, with an adapterless session
 * service and project storage under `home`. Tests that need live adapters
 * (rpc-session) build their own layers instead.
 */
export function makeRpcTestHarness(
  home: string,
  adapters: ReadonlyArray<HarnessAgentAdapter> = [],
) {
  const paths = layerPaths(home);
  const registryLayer = Layer.sync(HarnessAgentRegistry, () => makeHarnessAgentRegistry(adapters));
  const harnessSessionLayer = HarnessAgentSessionServiceLayer.pipe(Layer.provide(registryLayer));
  const listLayer = HarnessListLayer.pipe(Layer.provide(registryLayer));
  const probeLayer = HarnessProbeLayer.pipe(Layer.provide(registryLayer));
  const projectLayer = ProjectModuleLayer.pipe(Layer.provide(paths));
  const sessionServiceLayer = SessionServiceLayer.pipe(
    Layer.provide(projectLayer),
    Layer.provide(SessionRepositoryLayer.pipe(Layer.provide(paths))),
    Layer.provide(HarnessAgentSessionPortLayer.pipe(Layer.provide(harnessSessionLayer))),
    Layer.provide(SessionManagerLayer.pipe(Layer.provide(EventBusLayer))),
    Layer.provide(EventBusLayer),
  );
  // registryLayer is merged in as well as provided into the session service;
  // Layer memoization (same reference) keeps it one registry instance.
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      EventBusLayer,
      sessionServiceLayer,
      projectLayer,
      registryLayer,
      listLayer,
      probeLayer,
      FileSystemServiceLayer,
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
