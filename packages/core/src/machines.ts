import { connectPipe, type PipeClient } from "@vibest/client/pipe"
import { peerHeaders, PROTOCOL } from "@vibest/protocol/protocol"
import type { DaemonStopping, InvalidCaller, ProtocolRejected } from "@vibest/protocol/rpc"
import { shortId } from "@vibest/schema/id"
import {
  AlreadyAdded,
  MachineFailed,
  MachineIncompatible,
  type MachineInfo,
  type MachineState,
  MachineUnavailable,
  type OutboxItem,
  UnknownMachine,
} from "@vibest/schema/machine"
import { Clock, Context, Duration, Effect, Exit, Fiber, Layer, Option, Predicate, Schema, Scope, Stream } from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import type * as Socket from "effect/socket/Socket"

import { Db, type MachineRow } from "./db.ts"
import { VibestdIdentity } from "./identity.ts"

export type PipeExit = { readonly code: number | undefined; readonly stderr: string }

export interface Pipe {
  readonly socket: Socket.Socket
  readonly exited: Effect.Effect<PipeExit>
}

export class MachineTransport extends Context.Service<
  MachineTransport,
  (argv: ReadonlyArray<string>) => Effect.Effect<Pipe, Error, Scope.Scope>
>()("vibest/MachineTransport") {}

export const ADD_TIMEOUT = Duration.seconds(30)
export const RETRY_FIRST = Duration.millis(500)
export const RETRY_MAX = Duration.seconds(120)
export const RETRY_RESET = Duration.seconds(60)
const EXIT_WAIT = Duration.seconds(1)

export const REMOTE_LINE = `sh -c 'p=$(command -v vibest) || p=$HOME/.local/bin/vibest; [ -x "$p" ] || { echo "vibest is not installed here" >&2; exit 127; }; exec "$p" connect'`

const NAME = /^[A-Za-z0-9._-]+$/
const UNSAFE = /[\p{Cc}\s]/u

export const nameProblem = (name: string) =>
  NAME.test(name) ? undefined : `machine name ${JSON.stringify(name)}: use only letters, digits, -, _ and .`

export const targetProblem = (target: string) => {
  const at = target.indexOf("@")
  if (target === "") return "the ssh target is empty"
  if (new TextEncoder().encode(target).length > 1024) return "the ssh target is longer than 1024 bytes"
  if (UNSAFE.test(target)) return "the ssh target has a space or a control character"
  if (target.startsWith("-")) return "the ssh target starts with -"
  if (at !== -1 && target.slice(0, at).includes(":"))
    return "the ssh target names a password; use a key (ssh-agent or ~/.ssh/config)"
  return undefined
}

export const sshArgv = (target: string) => {
  const port = /^(.+):(\d+)$/.exec(target)
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    ...(port === null ? [target] : ["-p", port[2]!, port[1]!]),
    REMOTE_LINE,
  ]
}

class MachineDown extends Schema.TaggedError<MachineDown>()("MachineDown", {
  message: Schema.String,
  stop: Schema.optional(Schema.Literals(["mismatch", "different"])),
  answered: Schema.optional(Schema.String),
}) {}

export const differentMessage = (name: string, answered: string) =>
  `${name} now answers as a different vibestd (${shortId(answered)}): its database was replaced or the target points elsewhere; remove the machine and add it again`

const exitReason = (name: string, exit: PipeExit) => {
  if (exit.code === 127) return `vibest is not installed on ${name}`
  const last = exit.stderr.trim().split("\n").at(-1)?.trim()
  return last || `ssh exited ${exit.code ?? "on a signal"}`
}

type LineError = RpcClientError.RpcClientError | ProtocolRejected | DaemonStopping | InvalidCaller | MachineDown

const LINE_TAGS: ReadonlySet<unknown> = new Set([
  "RpcClientError",
  "ProtocolRejected",
  "DaemonStopping",
  "InvalidCaller",
  "MachineDown",
])
const isLineError = (e: unknown): e is LineError => Predicate.hasProperty(e, "_tag") && LINE_TAGS.has(e._tag)

const alreadyNamed = (name: string) =>
  `a machine named ${name} is already added; remove it first (vibest machine rm ${name})`

export interface Link {
  readonly client: PipeClient
  readonly call: <A, E>(
    effect: Effect.Effect<A, E | LineError>,
  ) => Effect.Effect<A, Exclude<E, LineError> | MachineUnavailable | MachineIncompatible>
  readonly exited: Effect.Effect<PipeExit>
}

type Entry = {
  readonly state: MachineState
  readonly since: number
  readonly stop?: "mismatch" | "different" | undefined
  readonly reason?: string | undefined
  readonly vibestd?: string | undefined
  readonly version?: string | undefined
  readonly link?: Link | undefined
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const self = yield* VibestdIdentity
  const transport = yield* MachineTransport
  const scope = yield* Effect.scope
  const entries = new Map<string, Entry>()
  const fibers = new Map<string, Fiber.Fiber<void>>()

  const set = (name: string, entry: Omit<Entry, "since">) =>
    Effect.gen(function* () {
      const before = entries.get(name)
      entries.set(name, { ...entry, since: yield* Clock.currentTimeMillis })
      if (before?.state !== entry.state || before.reason !== entry.reason)
        yield* Effect.logInfo(`machine ${name}: ${entry.state}${entry.reason ? ` (${entry.reason})` : ""}`)
    })

  const open = (name: string, target: string) =>
    Effect.gen(function* () {
      const pipe = yield* transport(sshArgv(target)).pipe(
        Effect.mapError((e) => new MachineDown({ message: `cannot run ssh: ${e.message}` })),
      )
      const ended = pipe.exited.pipe(Effect.map((exit) => exitReason(name, exit)))
      const down = (error: unknown) =>
        ended.pipe(
          Effect.timeoutOption(EXIT_WAIT),
          Effect.map((reason) =>
            Option.getOrElse(reason, () =>
              error instanceof Error && error.message !== "" ? error.message : `the connection to ${name} failed`,
            ),
          ),
        )
      const unavailable = (message: string) => Effect.fail(new MachineUnavailable({ machine: name, message }))
      const line =
        (lost: (reason: string) => string) =>
        <A, E>(effect: Effect.Effect<A, E | LineError>) =>
          Effect.catchIf(
            Effect.raceFirst(
              effect,
              Effect.flatMap(ended, (reason) => Effect.fail(new MachineDown({ message: reason }))),
            ),
            isLineError,
            (e): Effect.Effect<never, MachineUnavailable | MachineIncompatible> => {
              switch (e._tag) {
                case "RpcClientError":
                  return Effect.flatMap(down(e), (reason) => unavailable(lost(reason)))
                case "MachineDown":
                  return unavailable(lost(e.message))
                case "ProtocolRejected":
                  return Effect.fail(new MachineIncompatible({ machine: name, message: `${name}: ${e.message}` }))
                case "DaemonStopping":
                case "InvalidCaller":
                  return unavailable(`${name}: ${e.message}`)
              }
            },
          )
      const call = line(
        (reason) =>
          `lost the line to ${name} during the call (${reason}); it may have happened there; check, then retry`,
      )
      const opening = line((reason) => reason)
      const client = yield* connectPipe(pipe.socket)
      const failed = (e: { readonly message: string }) => new MachineDown({ message: e.message })
      const ping = yield* opening(client.Ping(undefined)).pipe(Effect.mapError(failed))
      if (ping.protocol !== PROTOCOL)
        return yield* new MachineDown({
          message: `${name} runs vibest ${ping.version} (protocol ${ping.protocol ?? "none"}); run vibest update there`,
          stop: "mismatch",
        })
      const hello = yield* opening(
        RpcClient.withHeaders(
          client["Peer.Hello"]({ id: self.id, name: self.name, callsMe: name }),
          peerHeaders(self.id),
        ),
      ).pipe(Effect.mapError(failed))
      return { hello, version: ping.version, link: { client, call, exited: pipe.exited } satisfies Link }
    })

  const receive = (name: string, link: Link, item: OutboxItem) =>
    Effect.gen(function* () {
      const address = `${name}/${shortId(item.session)}`
      const outcome = yield* db.receivePeerItem({
        id: item.id,
        recipient: item.recipient,
        content: `${address}: ${item.content}${item.cut ? `… (full text: vibest result ${address})` : ""}`,
      })
      if (outcome === "unknown")
        yield* Effect.logWarning(
          `${name}: dropped a ${item.kind} for session ${item.recipient}, which this vibestd does not have`,
        )
      yield* link.client["Peer.Ack"]({ ids: [item.id] }, { headers: peerHeaders(self.id) })
    })

  type First = {
    readonly row: MachineRow
    readonly opened: Effect.Success<ReturnType<typeof open>>
    readonly scope: Scope.Closeable
  }

  const connection = (row: MachineRow, first: First | undefined) =>
    Effect.gen(function* () {
      if (first !== undefined) yield* Effect.addFinalizer(() => Scope.close(first.scope, Exit.void))
      yield* set(row.name, { state: "connecting", reason: entries.get(row.name)?.reason })
      const opened = first?.opened ?? (yield* open(row.name, row.target))
      if (opened.hello.id !== row.vibestdId)
        return yield* new MachineDown({
          message: differentMessage(row.name, opened.hello.id),
          stop: "different",
          answered: opened.hello.id,
        })
      yield* db.machineConnected(row.name)
      yield* set(row.name, {
        state: "connected",
        vibestd: opened.hello.name,
        version: opened.version,
        link: opened.link,
      })
      const link = opened.link
      const outbox = link.client["Peer.Outbox"](undefined, { headers: peerHeaders(self.id) }).pipe(
        Stream.runForEach((item) => receive(row.name, link, item)),
        Effect.matchCause({
          onSuccess: () => `${row.name} closed the connection`,
          onFailure: () => `${row.name} stopped answering`,
        }),
      )
      const reason = yield* link.exited.pipe(
        Effect.map((exit) => exitReason(row.name, exit)),
        Effect.raceFirst(
          outbox.pipe(
            Effect.flatMap((fallback) =>
              link.exited.pipe(
                Effect.timeoutOption(EXIT_WAIT),
                Effect.map((exit) =>
                  Option.match(exit, { onNone: () => fallback, onSome: (e) => exitReason(row.name, e) }),
                ),
              ),
            ),
          ),
        ),
      )
      return yield* new MachineDown({ message: reason })
    }).pipe(Effect.scoped)

  const supervise = (name: string, first: First | undefined): Effect.Effect<void> =>
    Effect.gen(function* () {
      let delay = RETRY_FIRST
      let given = first
      while (true) {
        const row = given?.row ?? (yield* db.machineNamed(name))
        if (row === undefined) return
        const down = yield* connection(row, given).pipe(Effect.flip)
        given = undefined
        if (down.stop !== undefined) {
          yield* set(name, {
            state: down.stop === "different" ? "different" : "unreachable",
            reason: down.message,
            stop: down.stop,
          })
          return
        }
        const was = entries.get(name)
        const now = yield* Clock.currentTimeMillis
        const wait =
          was?.state === "connected" && now - was.since >= Duration.toMillis(RETRY_RESET) ? RETRY_FIRST : delay
        yield* set(name, { state: "unreachable", reason: down.message })
        yield* Effect.sleep(wait)
        delay = Duration.min(Duration.times(wait, 2), RETRY_MAX)
      }
    })

  const start = (name: string, first?: First) =>
    Effect.gen(function* () {
      fibers.set(name, yield* Effect.forkIn(supervise(name, first), scope, { startImmediately: true }))
    })

  for (const row of yield* db.machines) yield* start(row.name)

  const failed = (message: string) => new MachineFailed({ message })

  const unavailable = (name: string, entry: Entry | undefined) =>
    entry?.stop === "mismatch"
      ? new MachineIncompatible({ machine: name, message: entry.reason ?? `${name} runs another protocol` })
      : new MachineUnavailable({
          machine: name,
          message:
            entry === undefined || entry.state === "connecting"
              ? `still connecting to ${name}`
              : `${name} is ${entry.state}${entry.reason ? `: ${entry.reason}` : ""}`,
        })

  return {
    add: (name: string, target: string) =>
      Effect.gen(function* () {
        const problem = nameProblem(name) ?? targetProblem(target)
        if (problem !== undefined) return yield* failed(problem)
        if ((yield* db.machineNamed(name)) !== undefined) return yield* failed(alreadyNamed(name))
        const pipe = yield* Scope.make()
        const opened = yield* open(name, target).pipe(
          Scope.provide(pipe),
          Effect.timeoutOrElse({
            duration: ADD_TIMEOUT,
            orElse: () => Effect.fail(new MachineDown({ message: `${name} did not answer in 30 s` })),
          }),
          Effect.mapError((e) =>
            e.stop === "mismatch" ? new MachineIncompatible({ machine: name, message: e.message }) : failed(e.message),
          ),
          Effect.onError(() => Scope.close(pipe, Exit.void)),
        )
        const id = opened.hello.id
        const added = id === self.id ? undefined : yield* db.addMachine({ name, target, vibestdId: id })
        if (added === undefined) {
          yield* Scope.close(pipe, Exit.void)
          if (id === self.id) return yield* failed(`${name} is this vibestd`)
          const same = yield* db.machineWithVibestd(id)
          if (same !== undefined) return yield* new AlreadyAdded({ machine: same.name, id })
          return yield* failed(alreadyNamed(name))
        }
        yield* start(name, { row: added, opened, scope: pipe })
        return { name, id, vibestd: opened.hello.name, version: opened.version }
      }),

    states: Effect.map(db.machines, (rows) =>
      rows.map((row) => {
        const entry = entries.get(row.name) ?? { state: "connecting" as const, since: row.connectedAt }
        const connected = entry.state === "connected"
        const info: MachineInfo = {
          name: row.name,
          target: row.target,
          id: row.vibestdId,
          state: entry.state,
          since: entry.since,
          ...(entry.reason === undefined || connected ? {} : { reason: entry.reason }),
          connectedAt: row.connectedAt,
          ...(connected && entry.vibestd !== undefined ? { vibestd: entry.vibestd } : {}),
          ...(connected && entry.version !== undefined ? { version: entry.version } : {}),
        }
        return { info, link: connected ? entry.link : undefined }
      }),
    ),

    remove: (name: string) =>
      Effect.gen(function* () {
        const fiber = fibers.get(name)
        fibers.delete(name)
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        entries.delete(name)
        if (!(yield* db.removeMachine(name)))
          return yield* new UnknownMachine({ machine: name, machines: (yield* db.machines).map((row) => row.name) })
      }),

    link: (name: string) =>
      Effect.gen(function* () {
        if ((yield* db.machineNamed(name)) === undefined)
          return yield* new UnknownMachine({ machine: name, machines: (yield* db.machines).map((row) => row.name) })
        const entry = entries.get(name)
        if (entry?.state === "connected" && entry.link !== undefined) return entry.link
        return yield* unavailable(name, entry)
      }),
  }
})

export class Machines extends Context.Service<Machines, Effect.Success<typeof make>>()("vibest/Machines") {
  static readonly layer = Layer.effect(Machines, make)
}
