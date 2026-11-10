import { Layout } from "@vibest/schema/layout"
import { Crypto, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"
import { SqlClient, type SqlError } from "effect/sql"

import type { DatabaseOpenFailed, SchemaMismatch } from "../db-schema.ts"
import { LayerNode } from "./layer-node.ts"

export const fileSystem = LayerNode.unbound(FileSystem.FileSystem)
export const path = LayerNode.unbound(Path.Path)
export const crypto = LayerNode.unbound(Crypto.Crypto)
export const childProcessSpawner = LayerNode.unbound(ChildProcessSpawner.ChildProcessSpawner)
export const sqlClient = LayerNode.unbound<DatabaseOpenFailed | SchemaMismatch | SqlError.SqlError>()(
  SqlClient.SqlClient,
)
export const layout = LayerNode.unbound(Layout)
