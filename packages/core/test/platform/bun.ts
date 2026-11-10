import fs from "node:fs/promises"
import process from "node:process"

import { BunServices } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SQL_NAMES } from "@vibest/core/db"
import { UserPlatform } from "@vibest/core/system-prompt"
import { Layer } from "effect"

const user = Layer.succeed(UserPlatform, {
  uid: process.getuid?.(),
  lstat: async (file) => {
    const st = await fs.lstat(file)
    return { symlink: st.isSymbolicLink(), directory: st.isDirectory(), uid: st.uid, mode: st.mode }
  },
})

export const services = Layer.mergeAll(BunServices.layer, user)

export const memorySqlite = SqliteClient.layer({ filename: ":memory:", disableWAL: true, ...SQL_NAMES })
