import { accepts, DAEMON_START_TIMEOUT, probe, stopByHand } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Git } from "@vibest/core/git"
import { Harness, Harnesses } from "@vibest/core/harness"
import type { HostEnv as HostEnvShape } from "@vibest/core/host"
import { Inbox } from "@vibest/core/inbox"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { Builtins, Plugins, PluginLoader, type Candidate } from "@vibest/core/plugins"
import { type ProcessPlatform, Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { Restarting } from "@vibest/core/restarting"
import { HostEnv, Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as UpdateCheck from "@vibest/core/update-check"
import { VERSION } from "@vibest/protocol/rpc"
import { newId } from "@vibest/schema/id"
import { Clock, Deferred, Duration, Effect, FileSystem, Layer, Schedule, type Scope, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import type { HttpServer } from "effect/http/HttpServer"
import type { SocketServer } from "effect/socket/SocketServer"
import type { SqlClient } from "effect/sql"

import * as Http from "./http.ts"
import * as Server from "./server.ts"

export const DaemonInfo = Schema.Struct({
  pid: Schema.Number,
  version: Schema.String,
  socket: Schema.String,
  startedAt: Schema.Number,
  instance: Schema.optional(Schema.String),
  command: Schema.optional(Schema.Array(Schema.String)),
})
export type DaemonInfo = typeof DaemonInfo.Type
const DaemonInfoJson = Schema.fromJsonString(DaemonInfo)

export const readDaemonInfo = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DaemonInfoJson)),
    Effect.option,
  )

export interface Host {
  readonly sqlite: (filename: string) => Layer.Layer<SqlClient.SqlClient, unknown>
  readonly socketServer: (path: string) => Layer.Layer<SocketServer, unknown>
  readonly httpServer: (path: string) => Layer.Layer<HttpServer, unknown>
  readonly plugins: PluginLoader["Service"]
  readonly builtins: ReadonlyArray<Candidate>
  readonly env: HostEnvShape
  readonly processes: ProcessPlatform
  readonly lock: (
    file: string,
  ) => Effect.Effect<((text: string) => Effect.Effect<void, Error>) | undefined, Error, Scope.Scope>
  readonly checkDatabase: (filename: string) => Effect.Effect<void, Error>
}

export { HANDOFF_ENV } from "./server.ts"

export const HANDOFF_TIMEOUT = Duration.seconds(30)

export const checkImport = (host: Host) => Effect.flatMap(Layout, (layout) => host.checkDatabase(layout.database))

export class DaemonLockUnavailable extends Schema.TaggedError<DaemonLockUnavailable>()("DaemonLockUnavailable", {
  message: Schema.String,
}) {}
export class DaemonNotAnswering extends Schema.TaggedError<DaemonNotAnswering>()("DaemonNotAnswering", {
  message: Schema.String,
}) {}
export class DaemonSocketInUse extends Schema.TaggedError<DaemonSocketInUse>()("DaemonSocketInUse", {
  message: Schema.String,
}) {}

const services = (host: Host, layout: Layout["Service"]) =>
  Layer.merge(
    Server.layer.pipe(Layer.provide(host.socketServer(layout.socket))),
    Http.layer.pipe(Layer.provide(host.httpServer(layout.httpSocket))),
  ).pipe(
    Layer.provideMerge(Sessions.layer),
    Layer.provideMerge(Processes.layer(host.processes)),
    Layer.provideMerge(Git.layer),
    Layer.provideMerge(
      Plugins.layer.pipe(
        Layer.provide(Layer.succeed(Builtins, host.builtins)),
        Layer.provide(Layer.succeed(PluginLoader, host.plugins)),
      ),
    ),
    Layer.provideMerge(Subscriptions.live),
    Layer.provideMerge(UpdateCheck.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(Harness.layer),
    Layer.provideMerge(Db.layer.pipe(Layer.provide(host.sqlite(layout.database)))),
    Layer.provideMerge(Runtimes.layer.pipe(Layer.provide(Layer.succeed(HostEnv, host.env)))),
    Layer.provideMerge(Harnesses.layer),
    Layer.provide(Drain.layer),
    Layer.provide(Restarting.layer),
    Layer.provide(Bus.layer),
  )

export const run = (host: Host, options: { readonly handoff?: boolean } = {}) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(layout.home, { recursive: true })
    let write: ((text: string) => Effect.Effect<void, Error>) | undefined
    const held = yield* host.lock(layout.daemonInfo).pipe(
      Effect.mapError(
        (e) =>
          new DaemonLockUnavailable({
            message: `cannot take vibestd's start lock ${layout.daemonInfo}: ${e.message}. Nothing was changed; check that file.`,
          }),
      ),
      Effect.flatMap((writer) => {
        if (writer) {
          write = writer
          return Effect.succeed(true)
        }
        if (options.handoff) return Effect.succeed(undefined)
        return probe(layout.socket).pipe(Effect.map((up) => (up ? false : undefined)))
      }),
      Effect.repeat({
        until: (done) => done !== undefined,
        schedule: Schedule.jittered(Schedule.spaced("100 millis")),
      }),
      Effect.timeoutOrElse({
        duration: options.handoff ? HANDOFF_TIMEOUT : DAEMON_START_TIMEOUT,
        orElse: () =>
          Effect.fail(
            new DaemonNotAnswering({
              message: `another vibestd held ${layout.daemonInfo} for ${Duration.format(DAEMON_START_TIMEOUT)} without answering on ${layout.socket}. Nothing was changed; see vibestd.log and \`vibest status\`.`,
            }),
          ),
      }),
    )
    if (!held) return yield* Effect.log(`vibestd is already running on ${layout.socket}`)
    const inUse = (yield* probe(layout.socket).pipe(Effect.repeat({ until: (up) => up, times: 2 })))
      ? "answers Ping (an vibestd that takes no start lock, from an older vibest)"
      : (yield* accepts(layout.socket))
        ? "accepts connections but does not answer Ping"
        : undefined
    if (inUse)
      return yield* new DaemonSocketInUse({
        message: `something on ${layout.socket} ${inUse}; it was left running. ${stopByHand(layout.socket, undefined)}`,
      })
    yield* fs.remove(layout.socket, { force: true })
    yield* fs.remove(layout.httpSocket, { force: true })
    if (options.handoff) {
      const backup = `${layout.database}.before-${VERSION}`
      for (const suffix of ["", "-wal"])
        if (yield* fs.exists(`${layout.database}${suffix}`))
          yield* fs.copyFile(`${layout.database}${suffix}`, `${backup}${suffix}`)
      yield* Effect.log(`vibestd took over from the previous one; its database is backed up at ${backup}`)
    }
    const identity = {
      pid: host.processes.pid,
      instance: yield* newId(),
      command: yield* VibestCommand,
      startedAt: yield* Clock.currentTimeMillis,
    }
    const shutdown = yield* Deferred.make<void>()
    yield* Layer.build(
      services(host, layout).pipe(
        Layer.provide(
          Layer.mergeAll(Layer.succeed(Server.Identity, identity), Layer.succeed(Server.Shutdown, shutdown)),
        ),
      ),
    )
    yield* fs.chmod(layout.socket, 0o600)
    yield* fs.chmod(layout.httpSocket, 0o600)
    const info: DaemonInfo = { ...identity, version: VERSION, socket: layout.socket }
    yield* write!(Schema.encodeSync(DaemonInfoJson)(info)).pipe(Effect.orDie)
    yield* fs.remove(`${layout.home}/vibestd.lock`, { force: true }).pipe(Effect.ignore)
    yield* Effect.log(`vibestd listening on ${layout.socket}`)
    yield* Deferred.await(shutdown)
    yield* Effect.sleep("200 millis")
  }).pipe(Effect.scoped)
