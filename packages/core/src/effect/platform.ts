import { Layout } from "@vibest/schema/layout"
import { Context, Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient, type SqlError } from "effect/sql"

import type { DatabaseOpenFailed, SchemaMismatch } from "../database/db-schema.ts"
import { LayerNode } from "./layer-node.ts"

export * as PlatformNode from "./platform.ts"

export const fileSystem = LayerNode.unbound(FileSystem.FileSystem)
export const path = LayerNode.unbound(Path.Path)
export const crypto = LayerNode.unbound(Crypto.Crypto)
export const childProcessSpawner = LayerNode.unbound(ChildProcessSpawner.ChildProcessSpawner)

export class SqlClientLayer extends Context.Service<
  SqlClientLayer,
  Layer.Layer<SqlClient.SqlClient, DatabaseOpenFailed | SchemaMismatch | SqlError.SqlError>
>()("vibest/SqlClientLayer") {}
export const sqlClientLayer = LayerNode.unbound(SqlClientLayer)
export const sqlClient = LayerNode.make({
  service: SqlClient.SqlClient,
  layer: Layer.unwrap(Effect.map(SqlClientLayer, (layer) => layer)),
  deps: [sqlClientLayer],
})
export const layout = LayerNode.unbound(Layout)
export const httpClient = LayerNode.make({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
