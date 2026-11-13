import { Layout } from "@vibest/schema/layout"
import { Context, Crypto, Effect, FileSystem, Layer, Path } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient, type SqlError } from "effect/sql"

import type { DatabaseOpenFailed, SchemaMismatch } from "../db-schema.ts"
import { LayerNode } from "./layer-node.ts"

export const fileSystem = LayerNode.unbound(FileSystem.FileSystem)
export const path = LayerNode.unbound(Path.Path)
export const crypto = LayerNode.unbound(Crypto.Crypto)
export const childProcessSpawner = LayerNode.unbound(ChildProcessSpawner.ChildProcessSpawner)
export const hostProvided =
  <E>() =>
  <R, Shape>(service: Context.Key<R, Shape>) =>
    LayerNode.make({
      service,
      layer: Layer.effect(service, Effect.die(`${service.key} is supplied by the host`) as Effect.Effect<Shape, E>),
      deps: [],
    })
export const sqlClient = hostProvided<DatabaseOpenFailed | SchemaMismatch | SqlError.SqlError>()(SqlClient.SqlClient)
export const layout = LayerNode.unbound(Layout)
export const httpClient = LayerNode.make({ service: HttpClient.HttpClient, layer: FetchHttpClient.layer, deps: [] })
