import { connectPipe, type PipeClient } from "@vibest/client/pipe"
import { Db } from "@vibest/core/database/db"
import type { MachineRow } from "@vibest/core/database/db-remote"
import { KeyedMutex } from "@vibest/core/effect/keyed-mutex"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { VibestdIdentity } from "@vibest/core/identity"
import { errorMessage, type MachineHook, type PluginNote, Plugins } from "@vibest/core/plugin"
import { Runtimes } from "@vibest/core/runtimes"
import { reconnectSchedule, type Runtime } from "@vibest/plugin/effect"
import { peerHeaders } from "@vibest/protocol/protocol"
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
  type RuntimeThere,
  type RuntimeView,
  UnknownMachine,
} from "@vibest/schema/machine"
import { PROTOCOL } from "@vibest/schema/version"
import {
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect"
import { RpcClient, type RpcClientError } from "effect/rpc"
import type * as Socket from "effect/socket/Socket"

type PipeExit = { readonly code: number | undefined; readonly stderr: string }

interface Pipe {
  readonly socket: Socket.Socket
  readonly exited: Effect.Effect<PipeExit>
}

export class MachineTransport extends Context.Service<
  MachineTransport,
  (argv: ReadonlyArray<string>) => Effect.Effect<Pipe, Error, Scope.Scope>
>()("vibest/MachineTransport") {
  static readonly node = LayerNode.unbound(MachineTransport)
}

const ADD_TIMEOUT = Duration.seconds(30)
export const RETRY_FIRST = Duration.millis(500)
const RETRY_MAX = Duration.seconds(120)
const RETRY_RESET = Duration.seconds(60)
const RETRY = reconnectSchedule({ first: RETRY_FIRST, max: RETRY_MAX })
const EXIT_WAIT = Duration.seconds(1)
export const REPAIR_PAUSE = Duration.seconds(30)

const cannotShow = (name: string, kind: string) =>
  `${name}'s ${kind} agents cannot be shown here; vibest peek ${name}/<id> reads them`

const shownKind = (here: ReadonlyArray<{ readonly id: string; readonly name?: string }>, kind: string) =>
  here.find((runtime) => runtime.id === kind)?.name ?? kind

const noteText = (note: PluginNote) => `${note.message}${note.fix === undefined ? "" : `; fix: ${note.fix}`}`

interface View {
  readonly terminals: ReadonlyMap<string, Runtime.Terminal>
  readonly as?: string | undefined
  readonly note?: string | undefined
}

const NONE: ReadonlyMap<string, Runtime.Terminal> = new Map()

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

const differentMessage = (name: string, answered: string) =>
  `${name} now answers as a different vibestd (${shortId(answered)}): its database was replaced or the target points elsewhere; remove the machine and add it again`

const exitReason = (name: string, exit: PipeExit) => {
  if (exit.code === 127) return `vibest is not installed on ${name}`
  const last = exit.stderr.trim().split("\n").at(-1)?.trim()
  return last || `ssh exited ${exit.code ?? "on a signal"}`
}

type LineError = RpcClientError.RpcClientError | ProtocolRejected | DaemonStopping | InvalidCaller | MachineDown

const LINE_TAGS: Record<LineError["_tag"], true> = {
  RpcClientError: true,
  ProtocolRejected: true,
  DaemonStopping: true,
  InvalidCaller: true,
  MachineDown: true,
}
const isLineError = (e: unknown): e is LineError =>
  Predicate.hasProperty(e, "_tag") && typeof e._tag === "string" && Object.hasOwn(LINE_TAGS, e._tag)

const alreadyNamed = (name: string) =>
  `a machine named ${name} is already added; remove it first (vibest machine rm ${name})`

interface Link {
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
  const plugins = yield* Plugins
  const runtimes = yield* Runtimes
  const entries = new Map<string, Entry>()
  const fibers = new Map<string, Fiber.Fiber<void>>()
  const there = new Map<string, { readonly runtimes: ReadonlyArray<RuntimeThere>; readonly at: number }>()
  const noted = new Map<string, Map<string, { readonly notes: ReadonlyArray<PluginNote>; readonly at: number }>>()
  const repairs = new Map<string, { readonly at: number; readonly note: string }>()
  const lock = KeyedMutex.keyedLock<string>()

  const heard = (name: string, runtimes: ReadonlyArray<RuntimeThere> | undefined) =>
    Effect.map(Clock.currentTimeMillis, (at) => void there.set(name, { runtimes: runtimes ?? [], at }))

  const fire = (row: MachineRow, hook: MachineHook, runtime?: string) =>
    Effect.gen(function* () {
      const fired = yield* plugins.machine(
        hook,
        { name: row.name, target: row.target, vibestd: row.vibestdId, runtimes: there.get(row.name)?.runtimes ?? [] },
        runtime,
      )
      if (hook === "connect") {
        const at = yield* Clock.currentTimeMillis
        const kept = noted.get(row.name) ?? new Map()
        for (const plugin of fired.plugins) {
          const notes = fired.notes.filter((note) => note.plugin === plugin)
          if (notes.length === 0) kept.delete(plugin)
          else kept.set(plugin, { notes, at })
        }
        noted.set(row.name, kept)
      }
      return fired.notes
    })

  const coreNotes = (name: string) =>
    Effect.map(runtimes.all, (here) =>
      (there.get(name)?.runtimes ?? [])
        .filter((r) => !here.some((h) => h.id === r.kind && h.locate !== undefined))
        .map((r): PluginNote => ({ message: cannotShow(name, shownKind(here, r.kind)) })),
    )

  const ensure = (name: string, kind: string, sessions: ReadonlyMap<string, string>, always = false) =>
    lock.withLock(name)(
      Effect.gen(function* () {
        const row = yield* db.machineNamed(name)
        const here = yield* runtimes.all
        const locate = here.find((r) => r.id === kind)?.locate
        const label = shownKind(here, kind)
        if (row === undefined || locate === undefined) return { terminals: NONE, note: cannotShow(name, label) } as View
        const seen = there.get(name)
        const reported = seen?.runtimes.find((r) => r.kind === kind)
        if (reported?.link === undefined)
          return {
            terminals: NONE,
            note:
              seen === undefined
                ? `${name} has not answered since vibestd started`
                : reported === undefined
                  ? `${name} has no ${kind} runtime`
                  : `${kind} on ${name} is ${reported.status}${reported.reason ? ` (${reported.reason})` : ""}`,
          } as View
        const look = locate({ id: name, target: row.target, link: reported.link }, sessions).pipe(
          Effect.catchCause((cause) =>
            Effect.succeed({
              missing: false,
              terminals: NONE,
              note: `${kind} here could not look for ${name}: ${errorMessage(cause)}`,
            }),
          ),
        )
        const first = yield* look
        if (!first.missing) return first as View
        const key = `${name}\0${kind}`
        const last = repairs.get(key)
        if (
          !always &&
          last !== undefined &&
          (yield* Clock.currentTimeMillis) - last.at < Duration.toMillis(REPAIR_PAUSE)
        )
          return { terminals: NONE, note: last.note } as View
        const notes = yield* fire(row, "connect", kind)
        const again = yield* look
        if (!again.missing) {
          repairs.delete(key)
          return again as View
        }
        const note = again.note ?? (notes.map(noteText).join("; ") || `${name}'s agents are not in ${label} here`)
        repairs.set(key, { at: yield* Clock.currentTimeMillis, note })
        return { terminals: NONE, note } as View
      }),
    )

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
        kind: item.kind,
        sender: address,
        content: `${item.content}${item.cut ? `… (full text: vibest result ${address})` : ""}`,
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
      yield* heard(row.name, opened.hello.runtimes)
      yield* set(row.name, {
        state: "connected",
        vibestd: opened.hello.name,
        version: opened.version,
        link: opened.link,
      })
      if (first === undefined) yield* Effect.forkScoped(lock.withLock(row.name)(fire(row, "connect")))
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
      let step = yield* Schedule.toStep(RETRY)
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
        if (was?.state === "connected" && now - was.since >= Duration.toMillis(RETRY_RESET)) {
          step = yield* Schedule.toStep(RETRY)
        }
        yield* set(name, { state: "unreachable", reason: down.message })
        const [, delay] = yield* Effect.orDie(step(now, undefined))
        yield* Effect.sleep(delay)
      }
    })

  const start = (name: string, first?: First) =>
    Effect.gen(function* () {
      fibers.set(name, yield* Effect.forkIn(supervise(name, first), scope, { startImmediately: true }))
    })

  yield* runtimes.added.pipe(
    Stream.runForEach((started) =>
      Effect.flatMap(db.machines, (rows) =>
        Effect.forEach(
          rows.filter((row) => entries.get(row.name)?.state === "connected"),
          (row) => Effect.forEach(started, (runtime) => lock.withLock(row.name)(fire(row, "connect", runtime))),
          { concurrency: "unbounded", discard: true },
        ),
      ),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  )

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

  const states = Effect.map(db.machines, (rows) =>
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
  )

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
        yield* heard(name, opened.hello.runtimes)
        const notes = yield* lock.withLock(name)(fire(added, "connect"))
        return {
          name,
          id,
          vibestd: opened.hello.name,
          version: opened.version,
          notes: [...(yield* coreNotes(name)), ...notes],
        }
      }),

    ensure,

    listing: Effect.flatMap(states, (rows) =>
      Effect.forEach(
        rows,
        ({ info }) =>
          Effect.gen(function* () {
            const seen = there.get(info.name)
            const views = yield* Effect.forEach(
              seen?.runtimes ?? [],
              (r) =>
                (info.state === "connected"
                  ? ensure(info.name, r.kind, new Map())
                  : Effect.succeed<View>({ terminals: NONE, note: `${info.name} is ${info.state}` })
                ).pipe(
                  Effect.map((view): RuntimeView => ({
                    kind: r.kind,
                    status: r.status,
                    ...(r.reason === undefined ? {} : { reason: r.reason }),
                    here: {
                      visible: view.note === undefined,
                      ...(view.as === undefined ? {} : { as: view.as }),
                      ...(view.note === undefined ? {} : { note: view.note }),
                    },
                  })),
                ),
              { concurrency: "unbounded" },
            )
            const notes = [...(noted.get(info.name)?.values() ?? [])].flatMap((kept) =>
              kept.notes.map((note) => ({ ...note, at: kept.at })),
            )
            return {
              ...info,
              runtimes: views,
              ...(seen === undefined ? {} : { runtimesAt: seen.at }),
              notes,
            } satisfies MachineInfo
          }),
        { concurrency: "unbounded" },
      ),
    ),

    states,

    remove: (name: string) =>
      Effect.gen(function* () {
        const row = yield* db.machineNamed(name)
        const fiber = fibers.get(name)
        fibers.delete(name)
        if (fiber !== undefined) yield* Fiber.interrupt(fiber)
        entries.delete(name)
        if (row === undefined || !(yield* db.removeMachine(name)))
          return yield* new UnknownMachine({ machine: name, machines: (yield* db.machines).map((row) => row.name) })
        const notes = yield* lock.withLock(name)(fire(row, "remove"))
        there.delete(name)
        noted.delete(name)
        for (const key of repairs.keys()) if (key.startsWith(`${name}\0`)) repairs.delete(key)
        return { notes }
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

  static readonly node = LayerNode.make({
    service: Machines,
    layer: Machines.layer,
    deps: [Db.node, MachineTransport.node, Plugins.node, Runtimes.node, VibestdIdentity.node],
  })
}
