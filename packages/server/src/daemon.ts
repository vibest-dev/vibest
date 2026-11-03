import { accepts, DAEMON_START_TIMEOUT, probe, stopByHand } from "@vibest/client/client"
import { Actions } from "@vibest/core/actions"
import { Agents } from "@vibest/core/agents"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Harness } from "@vibest/core/harness"
import { Inbox } from "@vibest/core/inbox"
import { Keychain, type KeychainPlatform } from "@vibest/core/keychain"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { Builtins, Plugins, PluginLoader, type Candidate } from "@vibest/core/plugins"
import { type ProcessPlatform, Processes } from "@vibest/core/processes"
import { Restarting } from "@vibest/core/restarting"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { TurnEnds } from "@vibest/core/turn-ends"
import { VERSION } from "@vibest/protocol/rpc"
import { Project } from "@vibest/vibest/project"
import * as GitWorkspace from "@vibest/vibest/workspace"
// vibestd (SPEC §14): one per machine, one socket. Start: take the flock on vibestd.pid (retrying while busy; exit once an vibestd that
// holds it answers); then if something still answers on vibest.sock, leave it and fail; else unlink it, open the
// database, recover sessions (the first poll tick), serve. Rows are kept. Host pieces (SQLite driver, socket
// server) come from the entry through `Host`, so this file stays on effect's abstract services.
import { Clock, Crypto, Deferred, Duration, Effect, FileSystem, Layer, Schedule, type Scope, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import type { HttpServer } from "effect/http/HttpServer"
import type { SocketServer } from "effect/socket/SocketServer"
import type { SqlClient } from "effect/sql"

import * as Http from "./http.ts"
import * as Server from "./server.ts"

/**
 * vibestd.pid (SPEC §14): written once vibestd serves its socket, removed when it stops. For people to read: nothing signals
 * the PID it names, which a stale file may share with another process by now. instance / command: an older vibestd did not write them.
 */
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

/** The vibestd.pid at `file`; none when it is missing or not one. */
export const readDaemonInfo = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(file)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DaemonInfoJson)),
    Effect.option,
  )

export interface Host {
  readonly sqlite: (filename: string) => Layer.Layer<SqlClient.SqlClient, unknown>
  readonly socketServer: (path: string) => Layer.Layer<SocketServer, unknown>
  /** The HTTP server on a unix socket (vibest-http.sock: the Claude plugin's poll, ack and hooks). */
  readonly httpServer: (path: string) => Layer.Layer<HttpServer, unknown>
  readonly plugins: PluginLoader["Service"]
  /** Builtin plugins of this app, after the default harness choice: the runtime plugins (runtime-port.md §2). */
  readonly builtinPlugins: ReadonlyArray<Candidate>
  /** Signal 0, vibestd's PID and user id (Processes). */
  readonly processes: ProcessPlatform
  /** A harness credential (the macOS keychain, or Claude's Linux file). The value is never logged. */
  readonly keychain: KeychainPlatform
  /**
   * Take the start lock on `file` (vibestd.pid) for the scope: a writer for the file's content once this process holds it,
   * undefined while another process does. Released, the file is left empty. Fails when the file cannot be opened.
   */
  readonly lock: (
    file: string,
  ) => Effect.Effect<((text: string) => Effect.Effect<void, Error>) | undefined, Error, Scope.Scope>
  /** Read-only: whether this vibest can open the database at `filename` (missing is fine); writes nothing. */
  readonly checkDatabase: (filename: string) => Effect.Effect<void, Error>
}

export { HANDOFF_ENV, type MainEnv } from "./server.ts"

/** How long the new vibestd of a handoff waits for the old one to release the lock. */
export const HANDOFF_TIMEOUT = Duration.seconds(30)

/** `vibest daemon import-check`: this vibest can take over the running vibestd's database (a handoff checks it first). */
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
    Layer.provideMerge(
      Plugins.layer.pipe(
        Layer.provide(Layer.succeed(Builtins, host.builtinPlugins)),
        Layer.provide(Layer.succeed(PluginLoader, host.plugins)),
      ),
    ),
    Layer.provideMerge(Subscriptions.live),
    Layer.provideMerge(Keychain.layer(host.keychain)),
    Layer.provideMerge(FetchHttpClient.layer),
    Layer.provideMerge(Inbox.layer),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(Harness.layer),
    Layer.provideMerge(GitWorkspace.layer),
    Layer.provideMerge(Db.layer.pipe(Layer.provide(host.sqlite(layout.database)))),
    // One registry per daemon (a Service, never a global), provided after every layer that reads it — a provideMerge
    // satisfies only requirements outstanding before it (runtime-port §2): two hosts in one process each get their own.
    Layer.provideMerge(Runtimes.layer),
    // The agent definitions plugins give: vibestd's alone (the command line reads none).
    Layer.provideMerge(Agents.layer),
    // What plugins do as a session: the server installs its handlers here; Plugins reads it.
    Layer.provideMerge(Actions.layer),
    Layer.provide(Drain.layer),
    Layer.provide(Restarting.layer),
    Layer.provide(TurnEnds.layer),
  )

/**
 * Run vibestd in this process until interrupted (SIGTERM / SIGINT through the runtime's runMain) or stopped by an accepted
 * Daemon.Stop. `handoff`: started by the running vibestd (Daemon.Handoff), so it waits for that one to release the lock
 * instead of leaving it running, and backs the database up before opening it.
 */
export const run = (host: Host, options: { readonly handoff?: boolean; readonly mainEnv?: Server.MainEnv } = {}) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(layout.home, { recursive: true })
    // Busy is transient: an vibestd whose socket is closed may still run its finalizers, or another starter is mid-attempt.
    // Each attempt is a fresh connection, closed when busy; retry until this one holds the lock or an vibestd answers.
    // Only then the socket. Taken first in this scope, the lock is released last: after the socket server has closed
    // and removed its path, so a successor's socket is never unlinked by this one.
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
        // A handoff's old vibestd still answers until it has drained and closed: wait for its lock, not its socket.
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
    // No other vibestd that takes the lock is starting or serving, so whatever answers took none: an older vibestd, or
    // another program. Its socket stays. One Ping can outlast its 1 s timeout on a loaded machine: three before "does
    // not answer".
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
    // The old vibestd closed the database with its lock: a copy of what it left, before this vibest opens (and migrates) it.
    if (options.handoff) {
      const backup = `${layout.database}.before-${VERSION}`
      for (const suffix of ["", "-wal"])
        if (yield* fs.exists(`${layout.database}${suffix}`))
          yield* fs.copyFile(`${layout.database}${suffix}`, `${backup}${suffix}`)
      yield* Effect.log(`vibestd took over from the previous one; its database is backed up at ${backup}`)
    }
    const identity = {
      pid: host.processes.pid,
      instance: yield* Effect.flatMap(Crypto.Crypto, (c) => c.randomUUIDv4).pipe(Effect.orDie),
      command: yield* VibestCommand,
      startedAt: yield* Clock.currentTimeMillis,
    }
    const shutdown = yield* Deferred.make<void>()
    yield* Layer.build(
      services(host, layout).pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(Server.Identity, identity),
            Layer.succeed(Server.Shutdown, shutdown),
            Layer.succeed(Server.MainEnv, options.mainEnv ?? new Map()),
          ),
        ),
      ),
    )
    // The socket files' permissions are the authentication (SPEC §13).
    yield* fs.chmod(layout.socket, 0o600)
    yield* fs.chmod(layout.httpSocket, 0o600)
    const info: DaemonInfo = { ...identity, version: VERSION, socket: layout.socket }
    // Into the locked file itself; releasing the lock empties it.
    yield* write!(Schema.encodeSync(DaemonInfoJson)(info)).pipe(Effect.orDie)
    // An older vibest's separate lock file, unused now (nothing that takes it can be serving: this one holds vibestd.pid
    // and the socket answered no one).
    yield* fs.remove(`${layout.home}/vibestd.lock`, { force: true }).pipe(Effect.ignore)
    yield* Effect.log(`vibestd listening on ${layout.socket}`)
    // Until interrupted (SIGTERM / SIGINT) or an accepted Daemon.Stop; then the scope closes the server, then the lock.
    yield* Deferred.await(shutdown)
    // ponytail: a short grace so the accepted Stop's reply is written before the server closes; a lost reply is still
    // handled by the client (it watches Ping), this only keeps the common case clean.
    yield* Effect.sleep("200 millis")
  }).pipe(Effect.scoped)
