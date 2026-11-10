import { accepts, DAEMON_START_TIMEOUT, probe, stopByHand } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db, type SchemaMismatch } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Git } from "@vibest/core/git"
import { Harness, Harnesses } from "@vibest/core/harness"
import { type HostFacts, loadIdentity, VibestdIdentity } from "@vibest/core/identity"
import { Inbox } from "@vibest/core/inbox"
import { Machines, type MachineTransport } from "@vibest/core/machines"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { Peers } from "@vibest/core/peer"
import { type PluginLoader, Plugins } from "@vibest/core/plugins"
import type { Processes } from "@vibest/core/processes"
import { Project } from "@vibest/core/project"
import { Remote } from "@vibest/core/remote"
import { SshHosts } from "@vibest/core/repository-url"
import { Restarting } from "@vibest/core/restarting"
import { type HostEnv, Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import * as UpdateCheck from "@vibest/core/update-check"
import { VERSION } from "@vibest/protocol/rpc"
import { newId } from "@vibest/schema/id"
import { Clock, Deferred, Duration, Effect, FileSystem, Layer, Schedule, type Scope, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import type { HttpServer } from "effect/http/HttpServer"
import type { ServeError } from "effect/http/HttpServerError"
import type { ChildProcessSpawner } from "effect/process"
import type { SocketServer, SocketServerError } from "effect/socket/SocketServer"
import type { SqlClient, SqlError } from "effect/sql"

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

export class LockFailed extends Schema.TaggedError<LockFailed>()("LockFailed", {
  file: Schema.String,
  message: Schema.String,
}) {}
export class DatabaseOpenFailed extends Schema.TaggedError<DatabaseOpenFailed>()("DatabaseOpenFailed", {
  file: Schema.String,
  message: Schema.String,
}) {}

export type PlatformServices = SqlClient.SqlClient | MachineTransport | PluginLoader | HostEnv | Processes

export interface Host {
  readonly layer: Layer.Layer<
    PlatformServices,
    DatabaseOpenFailed | SchemaMismatch | SqlError.SqlError,
    Layout | ChildProcessSpawner.ChildProcessSpawner
  >
  readonly servers: Layer.Layer<SocketServer | HttpServer, SocketServerError | ServeError, Layout>
  readonly lock: (
    file: string,
  ) => Effect.Effect<((text: string) => Effect.Effect<void, LockFailed>) | undefined, LockFailed, Scope.Scope>
  readonly checkDatabase: (filename: string) => Effect.Effect<void, DatabaseOpenFailed | SchemaMismatch>
  readonly facts: HostFacts
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

const services = (host: Host) =>
  Layer.merge(Server.layer, Http.layer).pipe(
    Layer.provide(host.servers),
    Layer.provideMerge(Remote.layer),
    Layer.provideMerge(Machines.layer),
    Layer.provideMerge(Peers.layer),
    Layer.provideMerge(Sessions.layer),
    Layer.provideMerge(Git.layer),
    Layer.provideMerge(SshHosts.layer),
    Layer.provideMerge(Plugins.layer),
    Layer.provideMerge(Subscriptions.live),
    Layer.provideMerge(UpdateCheck.layer),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(Harness.layer),
    Layer.provideMerge(Db.layer),
    Layer.provideMerge(Runtimes.layer),
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
    let write: ((text: string) => Effect.Effect<void, LockFailed>) | undefined
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
    const self = yield* loadIdentity(layout.identity, host.facts)
    if (self.warning !== undefined) yield* Effect.logWarning(self.warning)
    const identity = {
      pid: host.facts.pid,
      instance: yield* newId(),
      command: yield* VibestCommand,
      startedAt: yield* Clock.currentTimeMillis,
    }
    const shutdown = yield* Deferred.make<void>()
    yield* Layer.build(
      services(host).pipe(
        Layer.provide(
          Layer.mergeAll(
            host.layer,
            Layer.succeed(Server.Identity, identity),
            Layer.succeed(Server.Shutdown, shutdown),
            Layer.succeed(VibestdIdentity, { id: self.identity.id, name: self.identity.name }),
          ),
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
