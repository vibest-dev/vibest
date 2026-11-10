import { accepts, DAEMON_START_TIMEOUT, probe, type SocketConnector, stopByHand } from "@vibest/client/client"
import type { DatabaseOpenFailed, SchemaMismatch } from "@vibest/core/db"
import { LayerNode } from "@vibest/core/effect/layer-node"
import * as PlatformNode from "@vibest/core/effect/platform"
import { HostFacts } from "@vibest/core/identity"
import { type ImportFailed, refereeFailed, type Report } from "@vibest/core/import/import"
import type { ReplayDiffers } from "@vibest/core/journal"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { VERSION } from "@vibest/protocol/rpc"
import type { UnknownFact } from "@vibest/schema/event"
import { newId } from "@vibest/schema/id"
import { Clock, Console, Deferred, Duration, Effect, FileSystem, Layer, Schedule, type Scope, Schema } from "effect"

import { daemon } from "./app.ts"
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

export interface Host {
  readonly lock: (
    file: string,
  ) => Effect.Effect<((text: string) => Effect.Effect<void, LockFailed>) | undefined, LockFailed, Scope.Scope>
  readonly checkDatabase: (
    filename: string,
  ) => Effect.Effect<void, DatabaseOpenFailed | SchemaMismatch | UnknownFact | ReplayDiffers>
  readonly checkLedgerImport: (
    filename: string,
  ) => Effect.Effect<Report, DatabaseOpenFailed | SchemaMismatch | ImportFailed>
}

export { HANDOFF_ENV } from "./server.ts"

export const HANDOFF_TIMEOUT = Duration.seconds(30)
const STOP_REPLY_GRACE = Duration.millis(200)

const printed = (report: Report) =>
  Console.log(
    [
      `v1 events: ${report.events}`,
      `v2 facts: ${report.facts}`,
      `took: ${report.ms} ms`,
      `ends of already ended processes: ${report.counts.endsOfEndedProcesses}`,
      `turns lost: ${report.counts.turnsLost}`,
      `ends of already ended turns: ${report.counts.endsOfEndedTurns}`,
      `repeated peer keys: ${report.counts.duplicatePeerKeys}`,
      `undecodable peer starts: ${report.counts.undecodablePeerStarts}`,
      `referee: ${report.differences.length === 0 ? "passed" : "failed"}`,
    ].join("\n"),
  )

const checkLedgerImport = (host: Host, database: string) =>
  Effect.gen(function* () {
    const report = yield* host.checkLedgerImport(database)
    yield* printed(report)
    if (report.differences.length > 0) return yield* refereeFailed(report)
  })

export const checkImport = (host: Host, ledger: boolean) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    if (ledger) yield* checkLedgerImport(host, layout.database)
    else yield* host.checkDatabase(layout.database)
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

export const run = (host: Host, replacements: LayerNode.Replacements, options: { readonly handoff?: boolean } = {}) =>
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
    if (options.handoff) {
      const backup = `${layout.database}.before-${VERSION}`
      for (const suffix of ["", "-wal"])
        if (yield* fs.exists(`${layout.database}${suffix}`))
          yield* fs.copyFile(`${layout.database}${suffix}`, `${backup}${suffix}`)
      yield* Effect.log(`vibestd took over from the previous one; its database is backed up at ${backup}`)
    }
    const facts = yield* HostFacts.pipe(Effect.provide(LayerNode.compile(HostFacts.node, { replacements })))
    const identity = {
      pid: facts.pid,
      instance: yield* newId(),
      command: yield* VibestCommand,
      startedAt: yield* Clock.currentTimeMillis,
    }
    const shutdown = yield* Deferred.make<void>()
    yield* Layer.build(
      LayerNode.compile(daemon, {
        replacements: [
          ...replacements,
          PlatformNode.layout.replace(Layer.succeed(Layout, layout)),
          Server.Identity.node.replace(Layer.succeed(Server.Identity, identity)),
          Server.Shutdown.node.replace(Layer.succeed(Server.Shutdown, shutdown)),
        ],
      }),
    )
    yield* fs.chmod(layout.socket, 0o600)
    yield* fs.chmod(layout.httpSocket, 0o600)
    const info: DaemonInfo = { ...identity, version: VERSION, socket: layout.socket }
    yield* acquired.write(Schema.encodeSync(DaemonInfoJson)(info)).pipe(Effect.orDie)
    yield* fs.remove(`${layout.home}/vibestd.lock`, { force: true }).pipe(Effect.ignore)
    yield* Effect.log(`vibestd listening on ${layout.socket}`)
    yield* Deferred.await(shutdown)
    yield* Effect.sleep(STOP_REPLY_GRACE)
  }).pipe(Effect.scoped)
