import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import type * as VibestPlugin from "@vibest/plugin/effect"
import { Runtime as RuntimeApi } from "@vibest/plugin/effect"
import { launchLine, typedLine } from "@vibest/plugin/effect/launch"
import { Host } from "@vibest/plugin/host"
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  type FileSystem,
  Option,
  type Path,
  PubSub,
  Schedule,
  Schema,
  type Scope,
  Stream,
} from "effect"

import { API_REVISION, type Connection, type Pushed, type RexError } from "./client.ts"
import { keyEvents } from "./keys.ts"

export const RexTerminal = Schema.Struct({
  session: Schema.NonEmptyString,
  block: Schema.NonEmptyString,
})

export type RexTerminal = typeof RexTerminal.Type

export type Terminal = RexTerminal

export type Runtime = VibestPlugin.Runtime.RuntimeDefinition

export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent<RexTerminal>

export type AgentState = VibestPlugin.Runtime.AgentState

export const formatRexTerminal = (terminal: RexTerminal): string => `${terminal.session}/${terminal.block}`

export const KIND = "rex"

export const MIN_API_REVISION = API_REVISION

export const FLAVOR = "com.superlogical.terminal.shell"

export const MAX_FORMAT_BYTES = 983_040

export const TYPED_LAUNCH_MS = 120_000

const LABEL_LIMIT = 128

const SHELL_WAIT = Duration.seconds(30)

const FOLLOW_BACKOFF = Host.reconnectSchedule({ first: Duration.millis(500), max: Duration.seconds(30) })

const keyOf = (terminal: RexTerminal) => `${terminal.session}\0${terminal.block}`

export const agentStateOf = (state: string | undefined): AgentState =>
  state === undefined ? "unknown" : state === "working" || state === "blocked" ? state : "idle"

const INTERACTIVE_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

const LOGIN_WRAPPERS = new Set(["login"])

const programName = (name: string) => name.replace(/^-/, "").replace(/^.*\//, "")

export interface Foreground {
  readonly name: string
  readonly script?: string | undefined
}

export const atShell = (foreground: Foreground | null | undefined): boolean =>
  foreground !== null &&
  foreground !== undefined &&
  foreground.script === undefined &&
  INTERACTIVE_SHELLS.has(programName(foreground.name))

const beforeTheProgram = (foreground: Foreground | null | undefined) =>
  foreground === null || foreground === undefined || LOGIN_WRAPPERS.has(programName(foreground.name))

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])

export const inLoginShell = (shell: string, argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const name = programName(shell)

  if (POSIX_SHELLS.has(name)) return [shell, "-lic", '"$@"; exec "$0" -li', shell, ...argv]

  if (name === "fish") return [shell, "-lic", "command $argv[2..]; exec $argv[1] -li", shell, ...argv]

  return ["/bin/sh", "-c", '"$@"; exec "$0" -i', shell, ...argv]
}

export const withEnv = (env: Readonly<Record<string, string>>, argv: ReadonlyArray<string>) => {
  const pairs = Object.entries(env).map(([key, value]) => `${key}=${value}`)

  return pairs.length === 0 ? argv : ["/usr/bin/env", ...pairs, ...argv]
}

export const lastLines = (text: string, lines: number) => {
  if (lines <= 0) return ""
  const all = text.replace(/\n+$/, "").split("\n")

  return all.slice(-lines).join("\n")
}

const NOT_FOUND_CODES = new Set(["not_found", "session_not_found", "window_not_found", "block_not_found"])
const BUSY_CODES = new Set(["busy", "locked"])

export const failure = (error: RexError | { readonly message: string; readonly code?: undefined }) =>
  new RuntimeApi.RuntimeError({
    code:
      error.code === undefined
        ? "failed"
        : NOT_FOUND_CODES.has(error.code)
          ? "not_found"
          : BUSY_CODES.has(error.code)
            ? "busy"
            : error.code === "unreachable" || error.code === "incompatible"
              ? error.code
              : "failed",
    message: "method" in error ? `${error.method}: ${error.message}` : error.message,
  })

const Opened = Schema.Struct({ block_ids: Schema.NullOr(Schema.Array(Schema.NullOr(Schema.String))) })

const Created = Schema.Struct({
  session_id: Schema.String,
  initial_windows: Schema.optional(Schema.NullOr(Schema.Array(Opened))),
})

const Sessions = Schema.Struct({
  sessions: Schema.NullOr(Schema.Array(Schema.Struct({ session_id: Schema.String, label: Schema.String }))),
})

const ForegroundSchema = Schema.Struct({ name: Schema.String, script: Schema.optional(Schema.String) })

const Process = Schema.Struct({
  last_exit: Schema.NullOr(Schema.Struct({ exit_code: Schema.Number })),
  foreground: Schema.optional(Schema.NullOr(ForegroundSchema)),
})

const Formatted = Schema.Struct({
  content: Schema.String,
  id: Schema.optional(Schema.Number),
  eof: Schema.optional(Schema.Boolean),
})

const Blob = Schema.Struct({ id: Schema.Number, data: Schema.String, eof: Schema.Boolean })

const Status = Schema.Struct({
  records: Schema.Array(Schema.Struct({ id: Schema.optional(Schema.String), state: Schema.String })),
})

const ServerStatus = Schema.Struct({ host_id: Schema.String })

const Hosts = Schema.Struct({
  hosts: Schema.NullOr(Schema.Array(Schema.Struct({ label: Schema.String, host_id: Schema.optional(Schema.String) }))),
})

const Version = Schema.Struct({ rex_version: Schema.String })

const BlockEvent = Schema.Struct({
  block_id: Schema.String,
  name: Schema.String,
  payload: Schema.optional(Schema.Unknown),
})

const SessionEvent = Schema.Struct({
  session_id: Schema.String,
  event: Schema.Struct({ type: Schema.String, payload: Schema.optional(Schema.Unknown) }),
})

const ServerEvent = Schema.Struct({ type: Schema.String, payload: Schema.optional(Schema.Unknown) })

const ProcessChanged = Schema.Struct({ foreground: Schema.optional(Schema.NullOr(ForegroundSchema)) })

const StatusChanged = Schema.Struct({
  id: Schema.optional(Schema.String),
  record: Schema.Struct({ state: Schema.String }),
})

const Destroyed = Schema.Struct({ session_id: Schema.String })

const decoded =
  <A, I>(schema: Schema.Codec<A, I>) =>
  <E>(self: Effect.Effect<unknown, E>): Effect.Effect<A, E | RuntimeApi.RuntimeError> =>
    self.pipe(
      Effect.flatMap((value) =>
        Schema.decodeUnknownEffect(schema)(value).pipe(
          Effect.mapError(
            (e) => new RuntimeApi.RuntimeError({ code: "failed", message: `unexpected Rex answer: ${e}` }),
          ),
        ),
      ),
    )

const projectLabel = (project: string) =>
  project
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .at(-1) || "vibest"

const clip = (label: string) => label.slice(0, LABEL_LIMIT)

export const make = (deps: {
  readonly connect: Effect.Effect<Connection, RexError, Scope.Scope>
  readonly socket: string
  readonly scope: Scope.Scope
  readonly shell: string
  readonly typedLaunch?: Duration.Input
  readonly caller?: VibestPlugin.Runtime.RuntimeCaller<RexTerminal>
}): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const typedLaunchMs = Duration.toMillis(deps.typedLaunch ?? Duration.millis(TYPED_LAUNCH_MS))
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    const busy = new Set<string>()
    const known = new Map<string, RexTerminal>()
    const typedAt = new Map<string, number>()
    const waiting = new Map<string, Set<Deferred.Deferred<void>>>()
    let following = false

    const tooOld = (revision: number) =>
      `the Rex server at ${deps.socket} speaks API revision ${revision}, vibest needs ${MIN_API_REVISION} or newer: restart Rex Server (quit Rex and open it again) or update Rex`

    const compatible = Effect.gen(function* () {
      const connection = yield* deps.connect.pipe(Effect.mapError(failure))

      if (connection.revision < MIN_API_REVISION)
        return yield* new RuntimeApi.RuntimeError({ code: "incompatible", message: tooOld(connection.revision) })

      return connection
    })

    const wake = (key: string) =>
      Effect.forEach(waiting.get(key) ?? [], (waiter) => Deferred.succeed(waiter, undefined), { discard: true })

    const exited = (terminal: RexTerminal) => {
      const key = keyOf(terminal)
      busy.delete(key)
      typedAt.delete(key)

      return wake(key).pipe(Effect.andThen(PubSub.publish(events, { type: "exited", terminal })))
    }

    const foregroundChanged = (terminal: RexTerminal, foreground: Foreground | null | undefined) => {
      if (beforeTheProgram(foreground)) return Effect.void
      const key = keyOf(terminal)

      if (!atShell(foreground)) {
        busy.add(key)
        typedAt.delete(key)

        return Effect.void
      }

      return busy.has(key) ? exited(terminal) : wake(key)
    }

    const onBlockEvent = (sessionId: string, event: typeof BlockEvent.Type) => {
      const terminal: RexTerminal = { session: sessionId, block: event.block_id }
      known.set(keyOf(terminal), terminal)

      if (event.name === "process_changed") {
        const changed = Schema.decodeUnknownOption(ProcessChanged)(event.payload)

        return Option.isSome(changed) ? foregroundChanged(terminal, changed.value.foreground) : Effect.void
      }

      if (event.name === "child_exited") return exited(terminal)

      if (event.name === "program_status_changed") {
        const changed = Schema.decodeUnknownOption(StatusChanged)(event.payload)

        if (Option.isNone(changed) || (changed.value.id ?? "") !== "") return Effect.void

        return PubSub.publish(events, {
          type: "state",
          terminal,
          state: agentStateOf(changed.value.record.state),
        })
      }

      return Effect.void
    }

    const onPushed = (pushed: Pushed): Effect.Effect<void> => {
      const event = Schema.decodeUnknownOption(ServerEvent)(pushed.payload)

      if (pushed.type !== "event" || Option.isNone(event)) return Effect.void

      if (event.value.type === "session_destroyed") {
        const destroyed = Schema.decodeUnknownOption(Destroyed)(event.value.payload)

        if (Option.isNone(destroyed)) return Effect.void

        return Effect.forEach(
          [...known.entries()].filter(([, t]) => t.session === destroyed.value.session_id),
          ([key, t]) => {
            known.delete(key)

            return exited(t)
          },
          { discard: true },
        )
      }

      if (event.value.type !== "session_event") return Effect.void
      const inSession = Schema.decodeUnknownOption(SessionEvent)(event.value.payload)

      if (Option.isNone(inSession)) return Effect.void
      const { session_id: sessionId, event: inner } = inSession.value

      if (inner.type === "block_closed") {
        const closed = Schema.decodeUnknownOption(Schema.Struct({ block_id: Schema.String }))(inner.payload)

        if (Option.isNone(closed)) return Effect.void
        const terminal: RexTerminal = { session: sessionId, block: closed.value.block_id }
        known.delete(keyOf(terminal))

        return exited(terminal)
      }

      if (inner.type !== "block_event") return Effect.void
      const block = Schema.decodeUnknownOption(BlockEvent)(inner.payload)

      return Option.isSome(block) ? onBlockEvent(sessionId, block.value) : Effect.void
    }

    const subscribeOnce = (subscribed: () => void) =>
      Effect.gen(function* () {
        const connection = yield* compatible
        yield* connection.call("session.attach_all", { event_scope: "all" }).pipe(Effect.mapError(failure))
        subscribed()
        yield* PubSub.publish(events, { type: "reset" })
        yield* connection.pushed.pipe(Stream.runForEach(onPushed), Effect.mapError(failure))
      }).pipe(Effect.scoped, Effect.ignore)

    const follow = Effect.gen(function* () {
      let step = yield* Schedule.toStep(FOLLOW_BACKOFF)

      for (;;) {
        let subscribed = false
        yield* subscribeOnce(() => {
          subscribed = true
        })

        if (subscribed) {
          yield* PubSub.publish(events, { type: "reset" })
          step = yield* Schedule.toStep(FOLLOW_BACKOFF)
        }

        const [, delay] = yield* Effect.orDie(step(yield* Clock.currentTimeMillis, undefined))
        yield* Effect.sleep(delay)
      }
    }).pipe(Effect.ensuring(Effect.sync(() => (following = false))))

    const startFollowing = Effect.suspend(() => {
      if (following) return Effect.void
      following = true

      return follow.pipe(Effect.forkIn(deps.scope), Effect.asVoid)
    })

    const withConnection = <A>(use: (connection: Connection) => Effect.Effect<A, RuntimeApi.RuntimeError>) =>
      startFollowing.pipe(
        Effect.andThen(compatible),
        Effect.tap((connection) => call(connection, "session.attach_all", { event_scope: "session" })),
        Effect.flatMap(use),
        Effect.scoped,
      )

    const call = (connection: Connection, method: string, payload: Schema.JsonObject) =>
      connection.call(method, payload).pipe(Effect.mapError(failure))

    const rpc = (method: string, payload: Schema.JsonObject) => withConnection((c) => call(c, method, payload))

    const blockMethod = (connection: Connection, terminal: RexTerminal, method: string, args: Schema.JsonObject = {}) =>
      call(connection, "block.method", { session_id: terminal.session, block_id: terminal.block, method, args })

    const status: Runtime["status"] = () =>
      Effect.scoped(deps.connect).pipe(
        Effect.map((connection): VibestPlugin.Runtime.RuntimeStatus =>
          connection.revision < MIN_API_REVISION
            ? { status: "blocked", reason: tooOld(connection.revision) }
            : { status: "online" },
        ),
        Effect.catch((e): Effect.Effect<VibestPlugin.Runtime.RuntimeStatus> =>
          Effect.succeed(
            e.code === "incompatible"
              ? {
                  status: "blocked",
                  reason: `${e.message}: restart Rex Server (quit Rex and open it again) or update Rex`,
                }
              : {
                  status: "offline",
                  reason: `no Rex server answers at ${deps.socket} (open Rex, or run rex server start)`,
                },
          ),
        ),
      )

    const written = <A>(line: Effect.Effect<A, { readonly message: string }, FileSystem.FileSystem | Path.Path>) =>
      line.pipe(
        Effect.mapError((e) => new RuntimeApi.RuntimeError({ code: "failed", message: e.message })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
      )

    const commandOf = (launch: VibestPlugin.Launch) =>
      Effect.gen(function* () {
        const { VIBEST_EXECUTION: _, ...env } = launch.env

        const program =
          launch.argv.length === 0 ? [deps.shell, "-li"] : inLoginShell(deps.shell, yield* written(launchLine(launch)))

        return withEnv(env, program)
      })

    const firstBlock = (ids: ReadonlyArray<string | null> | null): Effect.Effect<string, RuntimeApi.RuntimeError> => {
      const id = ids?.find((b) => b !== null)

      return id === undefined || id === null
        ? Effect.fail(new RuntimeApi.RuntimeError({ code: "failed", message: "Rex created no block" }))
        : Effect.succeed(id)
    }

    const sessionNamed = (connection: Connection, label: string) =>
      call(connection, "session.list", {}).pipe(
        decoded(Sessions),
        Effect.map((r) => r.sessions?.find((s) => s.label === label || s.session_id === label)?.session_id),
      )

    const isMissing = (e: RuntimeApi.RuntimeError) => e.code === "not_found"

    const open: VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["open"] = (input) =>
      withConnection((connection) =>
        Effect.gen(function* () {
          const command = yield* commandOf(input.launch)
          const focus = input.focus ?? false

          const layout = {
            block: {
              flavor: FLAVOR,
              label: clip(input.label),
              options: { shell: "none", command, cwd: input.cwd, close_on_exit: false },
            },
          }

          const inWindow = (sessionId: string) =>
            call(connection, "session.new_window", {
              session_id: sessionId,
              window_label: clip(input.label),
              focus,
              layout,
            }).pipe(
              decoded(Opened),
              Effect.flatMap((r) => firstBlock(r.block_ids)),
              Effect.map((blockId): RexTerminal => ({ session: sessionId, block: blockId })),
            )

          const near = input.near

          const beside =
            near !== undefined && input.split === true
              ? call(connection, "session.new_split", {
                  session_id: near.session,
                  anchor_id: near.block,
                  direction: "horizontal",
                  side: "after",
                  focus,
                  layout,
                }).pipe(
                  decoded(Opened),
                  Effect.flatMap((r) => firstBlock(r.block_ids)),
                  Effect.map((blockId): RexTerminal => ({ session: near.session, block: blockId })),
                )
              : near !== undefined
                ? inWindow(near.session)
                : !input.remote && input.target !== undefined && input.target !== ""
                  ? sessionNamed(connection, input.target).pipe(
                      Effect.flatMap((sessionId) =>
                        sessionId === undefined
                          ? Effect.fail(new RuntimeApi.RuntimeError({ code: "not_found", message: input.target ?? "" }))
                          : inWindow(sessionId),
                      ),
                    )
                  : Effect.fail(new RuntimeApi.RuntimeError({ code: "not_found", message: "no session to open in" }))

          const label = projectLabel(input.project)

          const ownSession = sessionNamed(connection, label).pipe(
            Effect.flatMap((sessionId) =>
              sessionId !== undefined
                ? inWindow(sessionId)
                : call(connection, "session.create", {
                    label,
                    initial_windows: [{ window_label: clip(input.label), layout }],
                  }).pipe(
                    decoded(Created),
                    Effect.flatMap((r) =>
                      firstBlock(r.initial_windows?.[0]?.block_ids ?? null).pipe(
                        Effect.map((blockId): RexTerminal => ({ session: r.session_id, block: blockId })),
                      ),
                    ),
                  ),
            ),
          )

          const terminal = yield* beside.pipe(Effect.catchIf(isMissing, () => ownSession))
          known.set(keyOf(terminal), terminal)

          return terminal
        }),
      )

    const event = (connection: Connection, terminal: RexTerminal, type: string, payload: Schema.JsonObject) =>
      call(connection, "block.event", {
        session_id: terminal.session,
        block_id: terminal.block,
        event: { type, payload },
      })

    const pressKeys = (connection: Connection, terminal: Terminal, keys: ReadonlyArray<string>) =>
      Effect.forEach(
        keys,
        (key) => {
          const presses = keyEvents(key)

          return presses === undefined
            ? Effect.fail(new RuntimeApi.RuntimeError({ code: "failed", message: `Rex has no key named ${key}` }))
            : Effect.forEach(presses, (press) => event(connection, terminal, "key", press), { discard: true })
        },
        { discard: true },
      )

    const typeText = (connection: Connection, terminal: Terminal, text: string, keys: ReadonlyArray<string>) =>
      event(connection, terminal, "paste", { text }).pipe(
        Effect.andThen(pressKeys(connection, terminal, ["enter", ...keys])),
      )

    const send: VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["send"] = (terminal, { text, keys }) =>
      withConnection((connection) =>
        text === undefined
          ? pressKeys(connection, terminal, keys ?? [])
          : typeText(connection, terminal, text, keys ?? []),
      )

    const read: VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["read"] = (terminal, lines) =>
      withConnection((connection) =>
        Effect.gen(function* () {
          const first = yield* blockMethod(connection, terminal, "format", {
            format: "text",
            trim: true,
            max_bytes: MAX_FORMAT_BYTES,
          }).pipe(decoded(Formatted))

          const id = first.id

          if (id === undefined || first.eof === true) return lastLines(first.content, lines)
          const encoder = new TextEncoder()
          const parts = [first.content]
          let offset = encoder.encode(first.content).length
          let more = true

          while (more) {
            const blob = yield* blockMethod(connection, terminal, "blob_read", {
              id,
              offset,
              max_bytes: MAX_FORMAT_BYTES,
            }).pipe(decoded(Blob))

            parts.push(blob.data)
            offset += encoder.encode(blob.data).length
            more = !blob.eof && blob.data !== ""
          }

          return lastLines(parts.join(""), lines)
        }),
      )

    const processOf = (connection: Connection, terminal: Terminal) =>
      blockMethod(connection, terminal, "process").pipe(decoded(Process))

    const process: VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["process"] = (terminal) =>
      withConnection((connection) =>
        processOf(connection, terminal).pipe(
          Effect.flatMap((p) =>
            Clock.currentTimeMillis.pipe(
              Effect.map((now) => {
                if (p.last_exit !== null) return { running: false, exitCode: p.last_exit.exit_code }

                if (beforeTheProgram(p.foreground)) return { running: true }
                const key = keyOf(terminal)

                if (!atShell(p.foreground)) {
                  busy.add(key)
                  known.set(key, terminal)
                  typedAt.delete(key)

                  return { running: true }
                }

                const typed = typedAt.get(key)

                return { running: typed !== undefined && now - typed < typedLaunchMs }
              }),
            ),
          ),
        ),
      )

    const state: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["state"]> = (terminal) =>
      withConnection((connection) =>
        blockMethod(connection, terminal, "program_status").pipe(
          decoded(Status),
          Effect.map((r) => agentStateOf(r.records.find((record) => (record.id ?? "") === "")?.state)),
        ),
      )

    const close: VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["close"] = (terminal) =>
      rpc("block.close", { session_id: terminal.session, block_id: terminal.block }).pipe(
        Effect.asVoid,
        Effect.catchIf(isMissing, () => Effect.void),
      )

    const backToShell = (connection: Connection, terminal: RexTerminal) =>
      Deferred.make<void>().pipe(
        Effect.flatMap((back) => {
          const key = keyOf(terminal)
          const waiters = waiting.get(key) ?? new Set()
          waiting.set(key, waiters.add(back))

          return Effect.gen(function* () {
            const p = yield* processOf(connection, terminal)

            if (p.last_exit !== null)
              return yield* new RuntimeApi.RuntimeError({
                code: "not_found",
                message: `the program of ${formatRexTerminal(terminal)} has ended and left no shell`,
              })

            if (atShell(p.foreground)) return
            yield* Deferred.await(back).pipe(
              Effect.timeoutOrElse({
                duration: SHELL_WAIT,
                orElse: () =>
                  Effect.fail(
                    new RuntimeApi.RuntimeError({
                      code: "busy",
                      message: `terminal ${formatRexTerminal(terminal)} did not come back to its shell within ${Duration.format(SHELL_WAIT)}`,
                    }),
                  ),
              }),
            )
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                waiters.delete(back)

                if (waiters.size === 0 && waiting.get(key) === waiters) waiting.delete(key)
              }),
            ),
          )
        }),
      )

    const run: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["run"]> = (terminal, launch) =>
      withConnection((connection) =>
        Effect.gen(function* () {
          yield* backToShell(connection, terminal)
          const line = yield* written(typedLine(launch))
          const key = keyOf(terminal)
          typedAt.set(key, yield* Clock.currentTimeMillis)
          yield* typeText(connection, terminal, line, []).pipe(
            Effect.tapError(() => Effect.sync(() => typedAt.delete(key))),
          )
        }),
      )

    const focus: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["focus"]> = (terminal) =>
      rpc("session.focus_block", { session_id: terminal.session, block_id: terminal.block }).pipe(Effect.asVoid)

    const present: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["present"]> = (terminal, info) => {
      const label = info["title"] || info["agent"]

      if (label === undefined || label === "") return Effect.void

      return rpc("session.set_block_label", {
        session_id: terminal.session,
        block_id: terminal.block,
        label: clip(label),
      }).pipe(Effect.asVoid)
    }

    const doctor: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["doctor"]> = () =>
      Effect.gen(function* () {
        const connection = yield* deps.connect

        const version = yield* connection.call("server.version", {}).pipe(
          decoded(Version),
          Effect.map((v) => v.rex_version),
          Effect.orElseSucceed(() => "unknown version"),
        )

        const checks: ReadonlyArray<VibestPlugin.Runtime.RuntimeCheck> = [
          { ok: true, text: `a Rex server answers at ${deps.socket}` },
          connection.revision >= MIN_API_REVISION
            ? { ok: true, text: `it speaks API revision ${connection.revision}` }
            : {
                ok: false,
                text: `it speaks API revision ${connection.revision}, vibest needs ${MIN_API_REVISION} or newer`,
                fix: "restart Rex Server (quit Rex and open it again) or update Rex",
              },
        ]

        return { name: `rex ${version}`, checks } satisfies VibestPlugin.Runtime.RuntimeReport
      }).pipe(
        Effect.scoped,
        Effect.catch(() =>
          Effect.succeed({
            name: "rex",
            checks: [
              {
                ok: false,
                text: `no Rex server answers at ${deps.socket}`,
                fix: "open Rex, or run rex server start",
              },
            ],
          }),
        ),
      )

    const link: NonNullable<Runtime["link"]> = () =>
      rpc("server.status", {}).pipe(
        decoded(ServerStatus),
        Effect.map((s) => ({ host: s.host_id })),
        Effect.orElseSucceed(() => undefined),
      )

    const NONE: ReadonlyMap<string, RexTerminal> = new Map()

    const locate: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<RexTerminal>["locate"]> = (remote) =>
      rpc("hosts.list", {}).pipe(
        decoded(Hosts),
        Effect.map((r): VibestPlugin.Runtime.Located<RexTerminal> => {
          const host = r.hosts?.find((h) => h.host_id !== undefined && h.host_id === remote.link["host"])

          return host === undefined
            ? {
                missing: false,
                terminals: NONE,
                note: `no Rex host here is ${remote.id}; add it with rex hosts to open its terminals`,
              }
            : {
                missing: false,
                terminals: NONE,
                as: host.label,
                note: `${remote.id}'s terminals are on Rex host ${host.label}: rex -S ${host.label}`,
              }
        }),
        Effect.orElseSucceed(() => ({
          missing: false,
          terminals: NONE,
          note: `Rex here cannot look for ${remote.id}`,
        })),
      )

    return RuntimeApi.define({
      id: KIND,
      ...(deps.caller !== undefined && { caller: deps.caller }),
      terminal: RexTerminal,
      format: formatRexTerminal,
      status,
      open,
      send,
      read,
      process,
      state,
      close,
      run,
      focus,
      present,
      doctor,
      link,
      locate,
      events: RuntimeApi.eventsFrom(events),
    })
  })
