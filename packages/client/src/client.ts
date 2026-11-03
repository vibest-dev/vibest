import {
  CALLER_HEADER,
  PROTOCOL,
  PROTOCOL_HEADER,
  protocolMismatch,
  REPOSITORY_HEADER,
  sessionHeaders,
} from "@vibest/protocol/protocol"
import { DaemonIdentity, VibestRpcs, type Ping, VERSION } from "@vibest/protocol/rpc"
import { Layout, VibestCommand, shellQuote } from "@vibest/schema/layout"
// The client side of vibest.sock (SPEC §12): one short connection per command. A missing daemon is started and waited for
// (up to 10 s) unless the caller is an agent. The existing Ping preflight is the only Ping: it detects a daemon whose
// Ping lacks this protocol before a mutation. Business requests carry their own headers and do not Ping again.
import { Cause, Config, Duration, Effect, Exit, FileSystem, Layer, Option, Path, Schedule, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { RpcClient, RpcSerialization } from "effect/rpc"
import * as Socket from "effect/socket/Socket"

import { SocketConnector } from "./socket-connector.ts"
export { SocketConnector } from "./socket-connector.ts"

/** What talking to vibestd needs from the environment. */
export type ClientServices = Layout | Path.Path | ChildProcessSpawner.ChildProcessSpawner | SocketConnector

export const DAEMON_START_TIMEOUT = Duration.seconds(10)

export class DaemonUnavailable extends Schema.TaggedError<DaemonUnavailable>()("DaemonUnavailable", {
  socket: Schema.String,
  message: Schema.String,
}) {}

/** How the user stops an vibestd this vibest cannot ask to stop: they check the PID themselves; vibest never signals it. */
export const stopByHand = (socket: string, pid: number | undefined) => {
  const p = pid === undefined ? "<pid>" : String(pid)
  return [
    `To replace it, check that \`ps -p ${p} -o command=\` shows an vibest daemon --foreground${pid === undefined ? " (its PID is in vibestd.pid next to the socket, not verified)" : ""},`,
    `stop it yourself with \`kill -TERM ${p}\`, wait until \`vibest status\` shows it not running on ${socket}, then run: vibest daemon`,
  ].join(" ")
}

export const described = (version: string, identity: DaemonIdentity) =>
  `vibestd ${version || "unknown"} (pid ${identity.pid ?? "unknown"}, ${identity.command ? identity.command.map(shellQuote).join(" ") : "command unknown"})`

/**
 * The answering daemon does not speak this protocol. Package version is not compared. No Hello is attempted.
 * `vibest daemon restart` asks it to stop in its own protocol (Daemon.Stop is the same call on every protocol).
 */
export class IncompatibleDaemon extends Schema.TaggedError<IncompatibleDaemon>()("IncompatibleDaemon", {
  socket: Schema.String,
  daemonVersion: Schema.String,
  daemonProtocol: Schema.NullOr(Schema.Number),
  daemon: DaemonIdentity,
  client: Schema.Struct({ version: Schema.String, command: Schema.Array(Schema.String) }),
}) {
  override get message() {
    const got = this.daemonProtocol === null ? "no protocol" : `protocol ${this.daemonProtocol}`
    const self = `vibest ${this.client.version} (${this.client.command.map(shellQuote).join(" ")})`
    const mismatch = protocolMismatch(
      PROTOCOL,
      this.daemonProtocol ?? 0,
      this.daemonVersion || "unknown",
      this.client.version,
    )
    return `${mismatch.message}. ${described(this.daemonVersion, this.daemon)} on ${this.socket} speaks ${got}; ${self} speaks protocol ${PROTOCOL}. If \`vibest daemon restart\` cannot replace it: ${stopByHand(this.socket, this.daemon.pid).replace(/^To replace it, /, "")}. A package-version difference alone does not require a restart.`
  }
}

export type VibestClient = Effect.Success<ReturnType<typeof connect>>

/** Who a scoped call is. A session does not declare itself coordinator. repositoryRoot on a session is the working directory, sent only for a coordinator. */
export type Claim =
  | { readonly _tag: "cli"; readonly repositoryRoot: string }
  | {
      readonly _tag: "session"
      readonly sessionId: string
      readonly repositoryRoot?: string
      /** The harness's own conversation id, when the caller knows it (Pi's session id). */
      readonly harnessSessionId?: string
      /** A harness integration's own version (vibest-plugin-version); the vibest CLI sends none. */
      readonly pluginVersion?: string
    }

export const protocolHeaders = () => ({ [PROTOCOL_HEADER]: String(PROTOCOL) })

export const cliHeaders = (repositoryRoot: string) => ({
  ...protocolHeaders(),
  [CALLER_HEADER]: "cli",
  [REPOSITORY_HEADER]: repositoryRoot,
})

/** The rest of a session's identity from its environment (vibestEnv / the main agent's launch) and its working directory. */
const fromEnv = Effect.gen(function* () {
  const read = (name: string) =>
    Config.option(Config.String(name)).pipe(Effect.map((v) => Option.getOrUndefined(v) || undefined))
  return {
    projectId: yield* read("VIBEST_PROJECT_ID"),
    agent: yield* read("VIBEST_AGENT"),
    harness: yield* read("VIBEST_HARNESS"),
    runtime: yield* read("VIBEST_RUNTIME"),
    cwd: (yield* Path.Path).resolve("."),
  }
}).pipe(Effect.orElseSucceed(() => ({})))

/** The headers of a call as `claim`: a session's from its environment (@vibest/protocol `sessionHeaders`). */
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
        }),
      )

/** A client on socket, closed with the scope. The protocol is built into the caller's scope: Effect.provide(layer) would close the socket as soon as the client is made. */
export const connect = (socket: string) =>
  Layer.build(
    // The JSON-RPC serialization does not encode the client's keep-alive pings, so the default 5 s ping timeout would cut
    // every call longer than that (an Inbox.Subscribe stream). A closed unix socket still fails the read at once.
    RpcClient.layerProtocolSocket({ pingInterval: "1 minute", pingTimeout: "1 day" }).pipe(
      Layer.provide(
        Layer.effect(
          Socket.Socket,
          Effect.flatMap(SocketConnector, (dial) => dial(socket)),
        ),
      ),
      Layer.provide(RpcSerialization.layerNdJsonRpc()),
    ),
  ).pipe(Effect.flatMap((protocol) => RpcClient.make(VibestRpcs).pipe(Effect.provide(protocol))))

/** How long one try of an integration's HTTP request may take to connect and return. */
export const HOOK_TIMEOUT = Duration.seconds(2)
/** The pause before the one retry: long enough for a vibestd handoff to start listening again. */
export const HOOK_RETRY_DELAY = Duration.millis(300)

/** The status and body of an HTTP/1.1 answer read whole: `Content-Length` or chunked, else to the close. */
const parseAnswer = (raw: string) => {
  const split = raw.indexOf("\r\n\r\n")
  if (split === -1) return undefined
  const head = raw.slice(0, split).split("\r\n")
  const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(head[0] ?? "")?.[1] ?? Number.NaN)
  const field = (name: string) =>
    head
      .find((h) => h.toLowerCase().startsWith(`${name}:`))
      ?.slice(name.length + 1)
      .trim()
  let body = raw.slice(split + 4)
  const length = field("content-length")
  if (length !== undefined) {
    if (new TextEncoder().encode(body).length < Number(length)) return undefined
  } else if (field("transfer-encoding")?.toLowerCase() === "chunked") {
    if (!body.endsWith("0\r\n\r\n")) return undefined
    let out = ""
    for (let at = 0; ;) {
      const eol = body.indexOf("\r\n", at)
      const size = Number.parseInt(body.slice(at, eol), 16)
      if (!size) break
      out += body.slice(eol + 2, eol + 2 + size)
      at = eol + 2 + size + 2
    }
    body = out
  }
  let parsed: unknown
  try {
    parsed = body === "" ? undefined : JSON.parse(body)
  } catch {
    parsed = undefined
  }
  return Number.isNaN(status) ? undefined : { status, body: parsed }
}

/**
 * A `POST route` with a JSON body to vibestd's HTTP socket (`vibest-http.sock`), on the platform's socket: its status
 * and parsed body. One request per connection.
 */
export const httpPost = (socketPath: string, route: string, headers: Readonly<Record<string, string>>, body: unknown) =>
  Effect.gen(function* () {
    const socket = yield* Effect.flatMap(SocketConnector, (dial) => dial(socketPath))
    const payload = JSON.stringify(body)
    const lines = [
      `POST ${route} HTTP/1.1`,
      "host: vibestd",
      "connection: close",
      "content-type: application/json",
      `content-length: ${new TextEncoder().encode(payload).length}`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
    ]
    const write = yield* socket.writer
    const pull = yield* Socket.readerBytes(socket)
    yield* write.write(`${lines.join("\r\n")}\r\n\r\n${payload}`)
    const decoder = new TextDecoder()
    let raw = ""
    for (;;) {
      const chunk = yield* pull.pipe(Effect.option)
      if (chunk._tag === "None") break
      for (const c of chunk.value) raw += decoder.decode(c, { stream: true })
      const answer = parseAnswer(raw)
      if (answer) return answer
    }
    const answer = parseAnswer(raw)
    if (!answer) return yield* Effect.fail(new Error(`vibestd gave no answer on ${socketPath}`))
    return answer
  }).pipe(Effect.scoped)

/**
 * An integration's one request to vibestd's HTTP socket; it never starts vibestd. Only a try whose connection could not
 * be made at all (ECONNREFUSED, ENOENT) is tried once more: once sent, vibestd may have handled it.
 */
export const hookPost = (
  socketPath: string,
  route: string,
  headers: Readonly<Record<string, string>>,
  body: unknown,
) => {
  const once = httpPost(socketPath, route, headers, body).pipe(Effect.timeout(HOOK_TIMEOUT), Effect.exit)
  return Effect.gen(function* () {
    const first = yield* once
    if (Exit.isSuccess(first)) return first.value
    const code = Option.getOrUndefined(Cause.findErrorOption(first.cause)) as { code?: unknown } | undefined
    if (!CONNECT_CODES.has(String(code?.code))) return yield* Effect.failCause(first.cause)
    yield* Effect.sleep(HOOK_RETRY_DELAY)
    const second = yield* once
    return Exit.isSuccess(second) ? second.value : yield* Effect.failCause(second.cause)
  })
}

/** Connecting failed before anything was sent: nothing listens on the socket, or there is no socket. */
const CONNECT_CODES = new Set(["ECONNREFUSED", "ENOENT"])

/** One Ping, or none if nothing answered in time. Does not judge protocol. */
export const readPing = (socket: string) =>
  connect(socket).pipe(
    Effect.flatMap((client) => client.Ping(undefined)),
    Effect.timeout("1 second"),
    Effect.option,
    Effect.scoped,
  )

/** Something answers on the socket. */
export const probe = (socket: string) =>
  readPing(socket).pipe(
    Effect.map(Option.isSome),
    Effect.orElseSucceed(() => false),
  )

/** Wait up to DAEMON_START_TIMEOUT for something to answer on the socket; false if nothing did. */
export const awaitDaemon = (socket: string) =>
  probe(socket).pipe(
    Effect.repeat({ until: (up) => up, schedule: Schedule.spaced("200 millis") }),
    Effect.timeoutOrElse({ duration: DAEMON_START_TIMEOUT, orElse: () => Effect.succeed(false) }),
  )

/** Something accepts connections on the socket, whether or not it answers Ping. A connect that hangs counts as yes. */
export const accepts = (socket: string) =>
  Effect.flatMap(SocketConnector, (dial) => dial(socket)).pipe(
    Effect.flatMap((s) => s.reader),
    Effect.as(true),
    Effect.scoped,
    Effect.orElseSucceed(() => false),
    Effect.timeoutOrElse({ duration: "1 second", orElse: () => Effect.succeed(true) }),
  )

/** Undefined when Ping speaks PROTOCOL. Package version is ignored. `self`: the argv that runs this vibest. */
export const incompatibleDaemon = (socket: string, ping: Ping, self: ReadonlyArray<string>) =>
  ping.protocol === PROTOCOL
    ? undefined
    : new IncompatibleDaemon({
        socket,
        daemonVersion: ping.version,
        daemonProtocol: ping.protocol ?? null,
        daemon: { pid: ping.pid, instance: ping.instance, command: ping.command, startedAt: ping.startedAt },
        client: { version: VERSION, command: self },
      })

/**
 * Start `command daemon --foreground` (plus `args`) detached, its output appended to ~/.vibest/vibestd.log; does not wait.
 * `vibest daemon --import` is the new vibestd of a handoff, started by the old one.
 */
/** `env`: added to the new vibestd's own environment only (a handoff's in-memory state); never written anywhere. */
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
            `mkdir -p "$1" && shift && exec "$@" >>"${log}" 2>&1`,
            "sh",
            layout.home,
            ...command,
            "daemon",
            "--foreground",
            ...args,
          ],
          {
            detached: true,
            ...(env ? { env, extendEnv: true } : {}),
            stdin: "ignore",
            stdout: "ignore",
            stderr: "ignore",
          },
        ),
      )
      yield* handle.unref
    }).pipe(
      Effect.scoped,
      Effect.mapError((e) => new DaemonUnavailable({ socket: layout.socket, message: e.message })),
    )
  })

/** Start `vibest daemon --foreground` detached (output appended to ~/.vibest/vibestd.log) and wait for its socket. */
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

/**
 * Run f on a fresh connection. One Ping checks liveness and protocol before the call; the call itself does not Ping.
 * A missing daemon is started unless start is false: an agent's command may run in its harness's sandbox, which a daemon
 * it started would inherit.
 */
export const withVibest = <A, E, R>(
  claim: Claim,
  f: (client: VibestClient) => Effect.Effect<A, E, R>,
  options?: { readonly start?: boolean },
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
    const incompatible = incompatibleDaemon(layout.socket, ping, yield* VibestCommand)
    if (incompatible) return yield* incompatible
    return yield* RpcClient.withHeaders(
      connect(layout.socket).pipe(Effect.flatMap((client) => f(client))),
      yield* claimHeaders(claim),
    )
  }).pipe(Effect.scoped)
