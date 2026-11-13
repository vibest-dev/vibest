import {
  CALLER_HEADER,
  MISMATCH_ACTION,
  PROTOCOL_HEADER,
  protocolMismatch,
  REPOSITORY_HEADER,
  sessionHeaders,
} from "@vibest/protocol/protocol"
import { DaemonIdentity, VibestRpcs, type Ping } from "@vibest/protocol/rpc"
import { Layout, VibestCommand, shellQuote } from "@vibest/schema/layout"
import { PROTOCOL, VERSION } from "@vibest/schema/version"
import {
  Cause,
  Config,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcSerialization } from "effect/rpc"
import * as Socket from "effect/socket/Socket"

import { SocketConnector } from "./socket-connector.ts"
export { SocketConnector } from "./socket-connector.ts"

export type ClientServices = Layout | Path.Path | ChildProcessSpawner.ChildProcessSpawner | SocketConnector

export const DAEMON_START_TIMEOUT = Duration.seconds(10)

export class DaemonUnavailable extends Schema.TaggedError<DaemonUnavailable>()("DaemonUnavailable", {
  socket: Schema.String,
  message: Schema.String,
}) {}

export const stopByHand = (socket: string, pid: number | undefined) => {
  const p = pid === undefined ? "<pid>" : String(pid)
  return [
    `To replace it, check that \`ps -p ${p} -o command=\` shows an vibest daemon --foreground${pid === undefined ? " (its PID is in vibestd.pid next to the socket, not verified)" : ""},`,
    `stop it yourself with \`kill -TERM ${p}\`, wait until \`vibest status\` shows it not running on ${socket}, then run: vibest daemon`,
  ].join(" ")
}

export const described = (version: string, identity: DaemonIdentity) =>
  `vibestd ${version || "unknown"} (pid ${identity.pid ?? "unknown"}, ${identity.command ? identity.command.map(shellQuote).join(" ") : "command unknown"})`

export class IncompatibleDaemon extends Schema.TaggedError<IncompatibleDaemon>()("IncompatibleDaemon", {
  socket: Schema.String,
  daemonVersion: Schema.String,
  daemonProtocol: Schema.NullOr(Schema.Number),
  daemon: DaemonIdentity,
  client: Schema.Struct({ version: Schema.String, command: Schema.Array(Schema.String) }),
  missing: Schema.optional(Schema.String),
}) {
  override get message() {
    const got = this.daemonProtocol === null ? "no protocol" : `protocol ${this.daemonProtocol}`
    const self = `vibest ${this.client.version} (${this.client.command.map(shellQuote).join(" ")})`
    const byHand = stopByHand(this.socket, this.daemon.pid).replace(/^To replace it, /, "")
    if (this.missing !== undefined)
      return `vibestd is older (${this.daemonVersion || "unknown"}); run ${MISMATCH_ACTION}. ${described(this.daemonVersion, this.daemon)} on ${this.socket} has no ${this.missing}, which ${self} needs. If \`vibest daemon restart\` cannot replace it: ${byHand}.`
    if (this.daemonProtocol !== null && this.daemonProtocol > PROTOCOL)
      return `${self} speaks protocol ${PROTOCOL}, older than ${described(this.daemonVersion, this.daemon)} on ${this.socket}, which speaks ${got}. Run ${MISMATCH_ACTION} (again, if this was ${MISMATCH_ACTION}): the newest vibest finishes the update and restarts the agents still on the old integration. To keep vibest ${this.client.version} instead (\`vibest daemon restart\` cannot, as vibestd refuses this older protocol): ${byHand}.`
    const mismatch = protocolMismatch(
      PROTOCOL,
      this.daemonProtocol ?? 0,
      this.daemonVersion || "unknown",
      this.client.version,
    )
    return `${mismatch.message}. ${described(this.daemonVersion, this.daemon)} on ${this.socket} speaks ${got}; ${self} speaks protocol ${PROTOCOL}. If \`vibest daemon restart\` cannot replace it: ${byHand}. A package-version difference alone does not require a restart.`
  }
}

export type VibestClient = Effect.Success<ReturnType<typeof connect>>

export type Claim =
  | { readonly _tag: "cli"; readonly repositoryRoot: string }
  | {
      readonly _tag: "session"
      readonly sessionId: string
      readonly repositoryRoot?: string
      readonly harnessSessionId?: string
      readonly pluginVersion?: string
      readonly process?: string
    }

export const protocolHeaders = () => ({ [PROTOCOL_HEADER]: String(PROTOCOL) })

export const cliHeaders = (repositoryRoot: string) => ({
  ...protocolHeaders(),
  [CALLER_HEADER]: "cli",
  [REPOSITORY_HEADER]: repositoryRoot,
})

const fromEnv = Effect.gen(function* () {
  const read = (name: string) =>
    Config.option(Config.String(name)).pipe(Effect.map((v) => Option.getOrUndefined(v) || undefined))
  return {
    projectId: yield* read("VIBEST_PROJECT_ID"),
    harness: yield* read("VIBEST_HARNESS"),
    runtime: yield* read("VIBEST_RUNTIME"),
    process: yield* read("VIBEST_PROCESS"),
    cwd: (yield* Path.Path).resolve("."),
  }
}).pipe(
  Effect.tapCause((cause) => Effect.logDebug(`session claim headers fell back to the request: ${Cause.pretty(cause)}`)),
  Effect.orElseSucceed(() => ({})),
)

export const claimHeaders = (claim: Claim) =>
  claim._tag === "cli"
    ? Effect.succeed(cliHeaders(claim.repositoryRoot))
    : Effect.map(fromEnv, (more) =>
        sessionHeaders({
          ...more,
          sessionId: claim.sessionId,
          repositoryRoot: claim.repositoryRoot,
          harnessSessionId: claim.harnessSessionId,
          pluginVersion: claim.pluginVersion,
          ...(claim.process === undefined ? {} : { process: claim.process }),
        }),
      )

export const clientOver = <E, R>(
  socket: Layer.Layer<Socket.Socket, E, R>,
  options?: Parameters<typeof RpcClient.layerProtocolSocket>[0],
) =>
  Layer.build(
    RpcClient.layerProtocolSocket(options).pipe(
      Layer.provide(socket),
      Layer.provide(RpcSerialization.layerNdJsonRpc()),
    ),
  ).pipe(Effect.flatMap((protocol) => RpcClient.make(VibestRpcs).pipe(Effect.provide(protocol))))

export const connect = (socket: string) =>
  clientOver(
    Layer.effect(
      Socket.Socket,
      Effect.flatMap(SocketConnector, (dial) => dial(socket)),
    ),
    { pingInterval: "1 minute", pingTimeout: "1 day" },
  )

export const HOOK_TIMEOUT = Duration.seconds(2)
export const HOOK_RETRY_DELAY = Duration.millis(300)

const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOENT"])
const notConnected = (error: unknown) => {
  if (!Predicate.hasProperty(error, "reason") || !Predicate.hasProperty(error.reason, "_tag")) return false
  if (error.reason._tag !== "SocketOpenError" || !Predicate.hasProperty(error.reason, "cause")) return false
  const cause = error.reason.cause
  return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) && CONNECT_CODES.has(cause.code)
}

export const hookCall = <A = void>(
  socket: string,
  headers: Readonly<Record<string, string>>,
  send: (client: VibestClient) => Effect.Effect<A, unknown>,
) => {
  const once = RpcClient.withHeaders(connect(socket).pipe(Effect.flatMap(send)), headers).pipe(
    Effect.scoped,
    Effect.timeout(HOOK_TIMEOUT),
    Effect.exit,
  )
  return Effect.gen(function* () {
    const first = yield* once
    if (Exit.isSuccess(first) || !Option.exists(Cause.findErrorOption(first.cause), notConnected)) return first
    yield* Effect.sleep(HOOK_RETRY_DELAY)
    return yield* once
  })
}

export const readPing = (socket: string) =>
  connect(socket).pipe(
    Effect.flatMap((client) => client.Ping(undefined)),
    Effect.timeout("1 second"),
    Effect.option,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause) ? Effect.succeed(Option.none<Ping>()) : Effect.failCause(cause),
    ),
    Effect.scoped,
  )

export const probe = (socket: string) =>
  readPing(socket).pipe(
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => false),
  )

export const awaitDaemon = (socket: string) =>
  probe(socket).pipe(
    Effect.repeat({ until: (up) => up, schedule: Schedule.spaced("200 millis") }),
    Effect.timeoutOrElse({ duration: DAEMON_START_TIMEOUT, orElse: () => Effect.succeed(false) }),
  )

export const accepts = (socket: string) =>
  Effect.flatMap(SocketConnector, (dial) => dial(socket)).pipe(
    Effect.flatMap((s) => s.reader),
    Effect.as(true),
    Effect.scoped,
    Effect.orElseSucceed(() => false),
    Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(true) }),
  )

export interface Needs {
  readonly capability: string
  readonly method: string
}

export const incompatibleDaemon = (socket: string, ping: Ping, self: ReadonlyArray<string>, needs?: Needs) => {
  const lacks = needs !== undefined && ping.capabilities?.[needs.capability] !== true
  return ping.protocol === PROTOCOL && !lacks
    ? undefined
    : new IncompatibleDaemon({
        socket,
        daemonVersion: ping.version,
        daemonProtocol: ping.protocol ?? null,
        daemon: { pid: ping.pid, instance: ping.instance, command: ping.command, startedAt: ping.startedAt },
        client: { version: VERSION, command: self },
        ...(ping.protocol === PROTOCOL && needs !== undefined ? { missing: needs.method } : {}),
      })
}

export const runCaptured = (
  argv: ReadonlyArray<string>,
  timeout: Duration.Duration,
  env: Record<string, string> = {},
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    return yield* spawner
      .spawn(
        ChildProcess.make(argv[0]!, argv.slice(1), {
          stdin: "ignore",
          env: { ...env, VIBEST_SESSION_ID: undefined },
          extendEnv: true,
        }),
      )
      .pipe(
        Effect.flatMap((handle) =>
          Effect.all(
            [
              Stream.mkString(Stream.decodeText(handle.stderr)),
              Stream.mkString(Stream.decodeText(handle.stdout)),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          ),
        ),
        Effect.map(([stderr, stdout, code]) =>
          code === 0 ? undefined : stderr.trim() || stdout.trim() || `exit ${code}`,
        ),
        Effect.scoped,
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () => Effect.succeed(`no answer in ${Duration.format(timeout)}`),
        }),
        Effect.catch((e) => Effect.succeed(e.message)),
      )
  })

export const importCheck = (command: ReadonlyArray<string>) =>
  Effect.flatMap(Layout, (layout) =>
    runCaptured([...command, "daemon", "import-check"], Duration.seconds(120), { VIBEST_HOME: layout.home }),
  )

export const spawnDaemon = (
  command: ReadonlyArray<string>,
  args: ReadonlyArray<string> = [],
  env?: Record<string, string>,
) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const path = yield* Path.Path
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
    const log = path.join(layout.home, "vibestd.log")
    yield* Effect.gen(function* () {
      const handle = yield* spawner.spawn(
        ChildProcess.make(
          "sh",
          [
            "-c",
            'mkdir -p "$1" && log=$2 && shift 2 && { "$@" >>"$log" 2>&1 & }',
            "sh",
            layout.home,
            log,
            ...command,
            "daemon",
            "--foreground",
            ...args,
          ],
          {
            detached: true,
            env,
            extendEnv: true,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
          },
        ),
      )
      yield* handle.unref
      const [said, code] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode], {
        concurrency: "unbounded",
      })
      if (code !== 0)
        return yield* Effect.fail(new Error(`vibestd was not started (exit ${code}): ${said.trim() || "no output"}`))
    }).pipe(
      Effect.scoped,
      Effect.mapError((e) => new DaemonUnavailable({ socket: layout.socket, message: e.message })),
    )
  })

export const startDaemon = Effect.gen(function* () {
  const layout = yield* Layout
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  const log = path.join(layout.home, "vibestd.log")
  const logAt = yield* fs.stat(log).pipe(
    Effect.map((info) => Number(info.size)),
    Effect.orElseSucceed(() => 0),
  )
  yield* spawnDaemon(yield* VibestCommand)
  if (yield* awaitDaemon(layout.socket)) return
  const bytes = yield* fs.readFile(log).pipe(Effect.orElseSucceed(() => new Uint8Array()))
  const text = Array.from(bytes.subarray(logAt), (b) => String.fromCharCode(b)).join("")
  const tagged = text
    .split("\n")
    .map((line) => /^([A-Z][A-Za-z0-9]*): (.+)$/.exec(line.trim()))
    .filter((m) => m !== null)
    .at(-1)
  return yield* new DaemonUnavailable({
    socket: layout.socket,
    message: tagged ? `${tagged[1]}: ${tagged[2]}` : `vibestd did not come up; see ${log}`,
  })
})

export const withVibest = <A, E, R>(
  claim: Claim,
  f: (client: VibestClient, ping: Ping) => Effect.Effect<A, E, R>,
  options?: { readonly start?: boolean; readonly needs?: Needs },
) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const up = yield* readPing(layout.socket)
    if (Option.isNone(up)) {
      if (options?.start === false)
        return yield* new DaemonUnavailable({
          socket: layout.socket,
          message: `vibestd is unreachable on ${layout.socket} (not running, or this process may not connect to its socket); ask the user to check it, or to run: vibest daemon`,
        })
      yield* startDaemon
    }
    const ping = Option.isSome(up) ? up.value : Option.getOrUndefined(yield* readPing(layout.socket))
    if (ping === undefined)
      return yield* new DaemonUnavailable({
        socket: layout.socket,
        message: `vibestd did not answer Ping on ${layout.socket}`,
      })
    const incompatible = incompatibleDaemon(layout.socket, ping, yield* VibestCommand, options?.needs)
    if (incompatible) return yield* incompatible
    return yield* RpcClient.withHeaders(
      connect(layout.socket).pipe(Effect.flatMap((client) => f(client, ping))),
      yield* claimHeaders(claim),
    )
  }).pipe(Effect.scoped)
