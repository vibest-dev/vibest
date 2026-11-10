import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Processes } from "@vibest/core/processes"
import { Effect, Layer } from "effect"

import { memorySqlite, services } from "../platform/bun.ts"
import { FakeGit } from "./fake-git.ts"
import { FakeProcesses } from "./fake-processes.ts"
import { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime.ts"

export const platform = LayerNode.make({ name: "test/Platform", layer: services, deps: [] })

export const fakeProcesses = LayerNode.make({ service: FakeProcesses, layer: FakeProcesses.layer, deps: [] })

export const processes = LayerNode.make({
  service: Processes,
  layer: Layer.effect(
    Processes,
    Effect.map(FakeProcesses, (fake) => fake.processes),
  ),
  deps: [fakeProcesses],
})

export const fakeGit = LayerNode.make({ name: "test/FakeGit", layer: FakeGit.layers, deps: [platform] })

export const fakeRuntime = (options: FakeRuntimeOptions = {}) =>
  LayerNode.make({ service: FakeRuntime, layer: FakeRuntime.layer(options), deps: [platform] })

export const base: LayerNode.Replacements = [
  PlatformNode.fileSystem.replace(platform),
  PlatformNode.path.replace(platform),
  PlatformNode.crypto.replace(platform),
  PlatformNode.childProcessSpawner.replace(platform),
  PlatformNode.sqlClient.replace(memorySqlite),
  Git.node.replace(fakeGit),
  Processes.node.replace(processes),
]

export const compile = <A, E>(root: LayerNode.Graph<A, E>, replacements: LayerNode.Replacements = []) =>
  LayerNode.compile(root, { replacements: [...base, ...replacements] })
