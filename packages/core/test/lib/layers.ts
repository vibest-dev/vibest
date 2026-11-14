import { equalToReplay } from "@vibest/core/bus"
import * as Projectors from "@vibest/core/database/projectors"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { Git } from "@vibest/core/git"
import { Processes } from "@vibest/core/processes"
import { Effect, Layer } from "effect"
import { SqlClient } from "effect/sql"

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

const hasLedger = (sql: SqlClient.SqlClient) =>
  sql`SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'event'`.pipe(Effect.map((rows) => rows.length > 0))

const replayChecked = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (!(yield* hasLedger(sql))) return
        const difference = yield* equalToReplay(sql).pipe(
          Effect.provide(Layer.fresh(Projectors.replay.pipe(Layer.provideMerge(memorySqlite)))),
        )
        if (difference !== undefined)
          return yield* Effect.die(new Error(`the projections differ from a replay of the log: ${difference}`))
      }).pipe(Effect.orDie),
    )
  }),
)

export const checkedSqlite = replayChecked.pipe(Layer.provideMerge(memorySqlite))

export const base: LayerNode.Replacements = [
  PlatformNode.fileSystem.replace(platform),
  PlatformNode.path.replace(platform),
  PlatformNode.crypto.replace(platform),
  PlatformNode.childProcessSpawner.replace(platform),
  PlatformNode.sqlClient.replace(checkedSqlite),
  Git.node.replace(fakeGit),
  Processes.node.replace(processes),
]

export const compile = <A, E>(root: LayerNode.Graph<A, E>, replacements: LayerNode.Replacements = []) =>
  LayerNode.compile(root, { replacements: [...base, ...replacements] })
