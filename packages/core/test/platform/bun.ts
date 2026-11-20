import fs from "node:fs/promises"
import process from "node:process"

import { BunServices, BunSocket } from "@effect/platform-bun"
import { SqliteClient } from "@effect/sql-sqlite-bun"
import { SocketConnector } from "@vibest/client/socket-connector"
import { Bus } from "@vibest/core/bus"
import { SQL_NAMES } from "@vibest/core/database/db"
import { Archive } from "@vibest/core/session/archive"
import { Sends } from "@vibest/core/session/sends"
import { Summaries } from "@vibest/core/session/summaries"
import { UserPlatform } from "@vibest/core/system-prompt"
import { Effect, Layer } from "effect"
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
  Layer.succeed(SocketConnector.Service, (endpoint: string) => BunSocket.makeNet({ path: endpoint })),
)

export const memorySqlite = SqliteClient.layer({ filename: ":memory:", disableWAL: true, ...SQL_NAMES })

export const memoryBus = Bus.layer.pipe(Layer.provide(memorySqlite))

const noSessions = Effect.die(new Error("this test has no sessions"))

export const memoryPluginHost = Layer.mergeAll(
  memoryBus,
  Layer.succeed(Summaries.Service, {
    list: () => Effect.succeed([]),
    get: () => Effect.succeed(undefined),
    sentIn: () => Effect.succeed(0),
  }),
  Layer.succeed(Sends.Service, {
    send: () => noSessions,
    deliverTo: () => noSessions,
    admit: () => noSessions,
    relay: () => noSessions,
  }),
  Layer.succeed(Archive.Service, {
    undoCutOffStart: () => noSessions,
    remove: () => noSessions,
    stop: () => noSessions,
    finishArchive: () => noSessions,
    archiveSoon: () => noSessions,
  }),
)
