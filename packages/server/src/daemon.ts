import { accepts, DAEMON_START_TIMEOUT, probe, stopByHand } from "@vibest/client/client"
import type { SocketConnector } from "@vibest/client/socket-connector"
import { App } from "@vibest/core/app"
import type { ReplayDiffers } from "@vibest/core/bus"
import type { DatabaseOpenFailed, SchemaMismatch } from "@vibest/core/database/db-schema"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { HostFacts } from "@vibest/core/identity"
import type { UnknownFact } from "@vibest/schema/event"
import { newId } from "@vibest/schema/id"
import { Layout, VibestCommand } from "@vibest/schema/layout"
import { Clock, Deferred, Duration, Effect, FileSystem, Layer, Schedule, type Scope, Schema } from "effect"

import { daemon } from "./app.ts"
import { Identity, Shutdown } from "./handlers/daemon.ts"
import * as ShutdownDeadline from "./shutdown-deadline.ts"
import type { ShutdownHost } from "./shutdown-deadline.ts"

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

export interface Host extends ShutdownHost {
  readonly lock: (
    file: string,
  ) => Effect.Effect<((text: string) => Effect.Effect<void, LockFailed>) | undefined, LockFailed, Scope.Scope>
  readonly checkDatabase: (
    filename: string,
  ) => Effect.Effect<void, DatabaseOpenFailed | SchemaMismatch | UnknownFact | ReplayDiffers>
}

const HANDOFF_TIMEOUT = Duration.seconds(30)
const STOP_REPLY_GRACE = Duration.millis(200)

export const checkImport = (host: Host) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    yield* host.checkDatabase(layout.database)
  })

export class DaemonLockUnavailable extends Schema.TaggedError<DaemonLockUnavailable>()("DaemonLockUnavailable", {
  message: Schema.String,
}) {}
export class DaemonNotAnswering extends Schema.TaggedError<DaemonNotAnswering>()("DaemonNotAnswering", {
  message: Schema.String,
}) {}
export class DaemonSocketInUse extends Schema.TaggedError<DaemonSocketInUse>()("DaemonSocketInUse", {
  message: Schema.String,
}) {}

export type Replacements = LayerNode.Replacements

export const run = (host: Host, replacements: Replacements, options: { readonly handoff?: boolean } = {}) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(layout.home, { recursive: true })
    const startTimeout = options.handoff ? HANDOFF_TIMEOUT : DAEMON_START_TIMEOUT
    type LockWait =
      | { readonly held: true; readonly write: (text: string) => Effect.Effect<void, LockFailed> }
      | { readonly held: false }
    const acquired = yield* host.lock(layout.daemonInfo).pipe(
      Effect.mapError(
        (e) =>
          new DaemonLockUnavailable({
            message: `cannot take vibestd's start lock ${layout.daemonInfo}: ${e.message}. Nothing was changed; check that file.`,
          }),
      ),
      Effect.flatMap((writer): Effect.Effect<LockWait | undefined, never, SocketConnector> => {
        if (writer) return Effect.succeed({ held: true, write: writer })
        if (options.handoff) return Effect.succeed(undefined)
        return probe(layout.socket).pipe(Effect.map((up) => (up ? { held: false } : undefined)))
      }),
      Effect.repeat({
        until: (done) => done !== undefined,
        schedule: Schedule.jittered(Schedule.spaced("100 millis")),
      }),
      Effect.timeoutOrElse({
        duration: startTimeout,
        orElse: () =>
          Effect.fail(
            new DaemonNotAnswering({
              message: `another vibestd held ${layout.daemonInfo} for ${Duration.format(startTimeout)} without answering on ${layout.socket}. Nothing was changed; see vibestd.log and \`vibest status\`.`,
            }),
          ),
      }),
    )
    if (acquired === undefined || !acquired.held)
      return yield* Effect.log(`vibestd is already running on ${layout.socket}`)
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
    const facts = yield* HostFacts.pipe(Effect.provide(LayerNode.compile(HostFacts.node, { replacements })))
    const app = yield* App.pipe(Effect.provide(LayerNode.compile(App.node, { replacements })))
    const identity = {
      pid: facts.pid,
      instance: yield* newId(),
      command: yield* VibestCommand,
      startedAt: yield* Clock.currentTimeMillis,
    }
    const shutdown = yield* Deferred.make<void>()
    const releases = new LayerNode.Releases()
    yield* ShutdownDeadline.install(host, releases, shutdown)
    yield* Layer.build(
      LayerNode.compile(daemon, {
        releases,
        replacements: [
          ...replacements,
          PlatformNode.layout.replace(Layer.succeed(Layout, layout)),
          Identity.node.replace(Layer.succeed(Identity, identity)),
          Shutdown.node.replace(Layer.succeed(Shutdown, shutdown)),
        ],
      }),
    )
    yield* fs.chmod(layout.socket, 0o600)
    yield* fs.chmod(layout.httpSocket, 0o600)
    const info: DaemonInfo = { ...identity, version: app.version, socket: layout.socket }
    yield* acquired.write(Schema.encodeSync(DaemonInfoJson)(info)).pipe(Effect.orDie)
    yield* fs.remove(`${layout.home}/vibestd.lock`, { force: true }).pipe(Effect.ignore)
    yield* Effect.log(`vibestd listening on ${layout.socket}`)
    yield* Deferred.await(shutdown)
    yield* Effect.sleep(STOP_REPLY_GRACE)
  }).pipe(Effect.scoped)
