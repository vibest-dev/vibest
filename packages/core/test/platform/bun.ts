import fs from "node:fs/promises"
import process from "node:process"

import { BunServices, BunSocket } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SocketConnector } from "@vibest/client/socket-connector"
import { SQL_NAMES } from "@vibest/core/database/db"
import { UserPlatform } from "@vibest/core/system-prompt"
import { Layer } from "effect"
import { FetchHttpClient } from "effect/http"

const user = Layer.succeed(UserPlatform, {
  uid: process.getuid?.(),
  lstat: async (file) => {
    const st = await fs.lstat(file)
    return { symlink: st.isSymbolicLink(), directory: st.isDirectory(), uid: st.uid, mode: st.mode }
  },
})

export const services = Layer.mergeAll(
  BunServices.layer,
  FetchHttpClient.layer,
  user,
  Layer.succeed(SocketConnector, (endpoint: string) => BunSocket.makeNet({ path: endpoint })),
)

export const memorySqlite = SqliteClient.layer({ filename: ":memory:", disableWAL: true, ...SQL_NAMES })
