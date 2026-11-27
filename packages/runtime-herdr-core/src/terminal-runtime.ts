import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import { api, type HcFailure, type HcClient, HcTransportError, type Notice } from "@vibest/herdr-core-sdk"
import type * as VibestPlugin from "@vibest/plugin/effect"
import { Runtime as RuntimeApi } from "@vibest/plugin/effect"
import { isShellHandoff, launchLine, typedLine } from "@vibest/plugin/effect/launch"
import { Host } from "@vibest/plugin/host"
import { ID } from "@vibest/schema/id"
import {
  Clock,
  Config,
  Deferred,
  Duration,
  Effect,
  type FileSystem,
  Option,
  type Path,
  Predicate,
  PubSub,
  type Scope,
  Schedule,
  Schema,
  Stream,
} from "effect"

export const HcTerminal = Schema.Struct({
  address: Schema.NonEmptyString,
  socket: Schema.optionalKey(Schema.NonEmptyString),
})

export type HcTerminal = typeof HcTerminal.Type

export type Terminal = HcTerminal

export type Runtime = VibestPlugin.Runtime.RuntimeDefinition

export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent<HcTerminal>

export type AgentState = VibestPlugin.Runtime.AgentState

export const hcTerminal = (socket: string, address: string, defaultSocket?: string): HcTerminal =>
  socket === defaultSocket ? { address } : { address, socket }

export const formatHcTerminal = (terminal: HcTerminal): string =>
  terminal.socket === undefined ? terminal.address : `${terminal.address}@${terminal.socket}`

export const agentStateOf = (status: api.Status | null | undefined): AgentState =>
  status === null || status === undefined
    ? "unknown"
    : status.state === "working" || status.state === "blocked"
      ? status.state
      : "idle"

export const KIND = "hc"

export const LABEL = {
  runtime: "vibest.runtime",
  project: "vibest.project",
  session: "vibest.session",
  seen: "herdr.seen",
  typed: "vibest.typed",
} as const

export const TYPED_LAUNCH_MS = 120_000

export const shellTypedRecently = (
  labels: Readonly<Record<string, string>> | undefined,
  atShellNow: boolean,
  now: number,
  windowMs: number,
): boolean => {
  if (!atShellNow) return false
  const typed = labels?.[LABEL.typed]

  if (typed === undefined || !/^\d+$/.test(typed)) return false

  return now - Number(typed) < windowMs
}

const SEEN_EVENTS = new Set(["turn", "labels"])

export const seenOf = (t: api.Terminal): VibestPlugin.Runtime.Seen => {
  const label = t.labels[LABEL.seen]
  const seen = label === undefined || !/^\d+$/.test(label) ? null : Number(label)

  return { finished: t.turn ?? 0, seen }
}

export const PRESENT_SESSION = "session"
export const PRESENT_PROJECT_ID = "projectId"

const INTERACTIVE_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

export const atShell = (foreground: Pick<api.Foreground, "name" | "argv"> | null | undefined): boolean => {
  if (foreground === null || foreground === undefined) return false
  const name = foreground.name.replace(/^-/, "").replace(/^.*\//, "")

  return INTERACTIVE_SHELLS.has(name) && foreground.argv.slice(1).every((arg) => arg.startsWith("-"))
}

const POSIX_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"])

export const inLoginShell = (shell: string, argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const name = shell.replace(/^.*\//, "")

  if (POSIX_SHELLS.has(name)) return [shell, "-lic", '"$@"; exec "$0" -li', shell, ...argv]

  if (name === "fish") return [shell, "-lic", "command $argv[2..]; exec $argv[1] -li", shell, ...argv]

  return ["/bin/sh", "-c", '"$@"; exec "$0" -i', shell, ...argv]
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export const terminalName = (input: VibestPlugin.Runtime.OpenInput<HcTerminal>, attempt = 0) => {
  const id = input.launch.env["VIBEST_SESSION_ID"]
  const session = id !== undefined && ID.test(id) ? id : undefined

  const base =
    session !== undefined
      ? slug(input.label) || slug(input.launch.env["VIBEST_HARNESS"] ?? "") || "agent"
      : slug(
          input.project
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .at(-1) ?? "",
        )

  const suffix = `${session?.slice(0, 4) ?? "main"}${attempt === 0 ? "" : `-${attempt + 1}`}`

  return `${base ? `${base.slice(0, 31 - suffix.length).replace(/-+$/, "")}-` : ""}${suffix}`
}

const NOT_FOUND_KINDS = new Set(["not_found", "finished", "machine_unknown"])

const codeOf = (kind: string): RuntimeApi.RuntimeError["code"] =>
  NOT_FOUND_KINDS.has(kind)
    ? "not_found"
    : kind === "blocked" || kind === "cancelled"
      ? "busy"
      : kind === "unavailable"
        ? "unreachable"
        : "failed"

export const failure = (
  error: HcFailure | { readonly _tag?: undefined; readonly message: string },
): RuntimeApi.RuntimeError => {
  if (Predicate.isTagged(error, "HcTransportError"))
    return new RuntimeApi.RuntimeError({ code: "unreachable", message: error.message })

  if (Predicate.isTagged(error, "HcError")) {
    const { kind, method } = error

    return new RuntimeApi.RuntimeError({ code: codeOf(kind), message: `${method}: ${error.message}` })
  }

  return new RuntimeApi.RuntimeError({ code: "failed", message: error.message })
}

const failWith = <A, R>(effect: Effect.Effect<A, HcFailure, R>) => effect.pipe(Effect.mapError(failure))

const SHELL_WAIT = Duration.seconds(30)
export const FOLLOW_ATTEMPTS = 8

const FOLLOW_BACKOFF = Host.reconnectSchedule({ first: Duration.millis(500), max: Duration.seconds(30) })

const EXIT_EVENTS = new Set(["finished", "removed", "lost"])

const decodeCreated = Schema.decodeUnknownSync(api.Terminal)
const decodeStatus = Schema.decodeUnknownSync(Schema.Struct({ status: Schema.optional(Schema.NullOr(api.Status)) }))
const decodeForeground = Schema.decodeUnknownSync(Schema.NullishOr(api.Foreground))

type Core = {
  readonly hc: HcClient
  readonly busy: Set<string>
  readonly waiting: Map<string, Set<Deferred.Deferred<void>>>
}

export const make = (deps: {
  readonly connect: (socketPath: string) => Effect.Effect<HcClient>
  readonly socket: string
  readonly scope: Scope.Scope
  readonly typedLaunch?: Duration.Input
  readonly name?: string
  readonly caller?: VibestPlugin.Runtime.RuntimeCaller<HcTerminal>
  readonly link?: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["link"]
  readonly locate?: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["locate"]
}): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const { connect, scope } = deps
    const typedLaunchMs = Duration.toMillis(deps.typedLaunch ?? Duration.millis(TYPED_LAUNCH_MS))
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    const cores = new Map<string, Core>()
    const home = yield* connect(deps.socket)

    const shell =
      Option.getOrElse(yield* Config.option(Config.String("SHELL")).pipe(Effect.orDie), () => "") || "/bin/sh"

    const wake = (core: Core, address: string) =>
      Effect.forEach(core.waiting.get(address) ?? [], (waiter) => Deferred.succeed(waiter, undefined), {
        discard: true,
      })

    const exited = (socket: string, core: Core, address: string) => {
      core.busy.delete(address)

      return wake(core, address).pipe(
        Effect.andThen(PubSub.publish(events, { type: "exited", terminal: hcTerminal(socket, address, deps.socket) })),
      )
    }

    const track = (core: Core, t: api.Terminal) => {
      if (t.state === "live" && t.argv.length > 0 && !atShell(t.foreground ?? { name: t.argv[0]!, argv: t.argv }))
        core.busy.add(t.address)
    }

    const onNotice = (socket: string, core: Core, notice: Notice): Effect.Effect<void, HcFailure> => {
      if (Predicate.isTagged(notice, "Subscribed"))
        return Effect.gen(function* () {
          core.busy.clear()

          for (const t of notice.result.terminals) track(core, t)

          for (const t of notice.result.terminals) if (!core.busy.has(t.address)) yield* wake(core, t.address)
          yield* PubSub.publish(events, { type: "reset" })
        })

      if (Predicate.isTagged(notice, "Notification"))
        return notice.method === "missed"
          ? Effect.fail(new HcTransportError({ method: "events.subscribe", message: "missed events" }))
          : Effect.void
      const { type, terminal, data } = notice.event

      if (type === "created") {
        track(core, decodeCreated(data))

        return Effect.void
      }

      if (EXIT_EVENTS.has(type)) return exited(socket, core, terminal)

      if (type === "status") {
        const state = agentStateOf(decodeStatus(data).status)

        return state === "unknown"
          ? Effect.void
          : PubSub.publish(events, {
              type: "state",
              terminal: hcTerminal(socket, terminal, deps.socket),
              state,
            })
      }

      if (SEEN_EVENTS.has(type))
        return PubSub.publish(events, {
          type: "seen",
          terminal: hcTerminal(socket, terminal, deps.socket),
        })

      if (type === "foreground") {
        if (!atShell(decodeForeground(data))) {
          core.busy.add(terminal)

          return core.hc
            .call("terminal.label", { terminal, labels: { [LABEL.typed]: "" } })
            .pipe(Effect.asVoid, Effect.ignore)
        }

        return core.busy.has(terminal) ? exited(socket, core, terminal) : wake(core, terminal)
      }

      return Effect.void
    }

    const follow = (socket: string, core: Core) =>
      Effect.gen(function* () {
        let failures = 0
        let step = yield* Schedule.toStep(FOLLOW_BACKOFF)

        while (socket === deps.socket || failures < FOLLOW_ATTEMPTS) {
          let subscribed = false
          yield* core.hc.subscribe({ labels: { [LABEL.runtime]: KIND } }).pipe(
            Stream.runForEach((notice) =>
              onNotice(socket, core, notice).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (Predicate.isTagged(notice, "Subscribed")) subscribed = true
                  }),
                ),
              ),
            ),
            Effect.ignore,
          )

          if (subscribed) {
            yield* PubSub.publish(events, { type: "reset" })
            step = yield* Schedule.toStep(FOLLOW_BACKOFF)
          }

          failures = subscribed ? 1 : failures + 1
          const [, delay] = yield* Effect.orDie(step(yield* Clock.currentTimeMillis, undefined))
          yield* Effect.sleep(delay)
        }
      })

    const coreAt = (socket: string) =>
      Effect.gen(function* () {
        const known = cores.get(socket)

        if (known !== undefined) return known

        const core: Core = {
          hc: socket === deps.socket ? home : yield* connect(socket),
          busy: new Set(),
          waiting: new Map(),
        }

        cores.set(socket, core)
        yield* follow(socket, core).pipe(Effect.ensuring(Effect.sync(() => cores.delete(socket))), Effect.forkIn(scope))

        return core
      })

    const reach = (terminal: HcTerminal) =>
      Effect.gen(function* () {
        const socket = terminal.socket ?? deps.socket
        const core = yield* coreAt(socket)

        return { hc: core.hc, core, socket, address: terminal.address }
      })

    const get = (terminal: Terminal) =>
      reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) => failWith(hc.call("terminal.get", { terminal: address }))),
      )

    const blocked = (e: { readonly message: string }) =>
      Effect.succeed({ status: "blocked" as const, reason: e.message })

    const status: Runtime["status"] = () =>
      home.hello.pipe(
        Effect.as({ status: "online" as const }),
        Effect.catchTags({
          HcGenerationMismatch: blocked,
          HcCoreTooOld: blocked,
          HcMethodsMissing: blocked,
        }),
        Effect.catch(() =>
          Effect.succeed({
            status: "offline" as const,
            reason: `no herdr-core answers at ${home.socketPath} (start one with hc server start)`,
          }),
        ),
      )

    const report = (
      name: string,
      checks: ReadonlyArray<VibestPlugin.Runtime.RuntimeCheck> = [],
    ): VibestPlugin.Runtime.RuntimeReport => ({ name, checks })

    const incompatible = () => Effect.succeed(report("herdr-core"))

    const doctor: NonNullable<Runtime["doctor"]> = () =>
      home.hello.pipe(
        Effect.map((hello) => report(`herdr-core ${hello.version.replace(/^hc /, "")}`)),
        Effect.catchTags({
          HcGenerationMismatch: incompatible,
          HcCoreTooOld: incompatible,
          HcMethodsMissing: incompatible,
        }),
        Effect.catch(() =>
          Effect.succeed(
            report("herdr-core", [{ ok: false, text: "herdr-core is not running", fix: "hc server start" }]),
          ),
        ),
      )

    const typeLine = (hc: HcClient, address: string, text: string) =>
      failWith(hc.call("terminal.send", { terminal: address, text })).pipe(Effect.asVoid)

    const written = <A>(line: Effect.Effect<A, { readonly message: string }, FileSystem.FileSystem | Path.Path>) =>
      line.pipe(
        Effect.mapError((e) => new RuntimeApi.RuntimeError({ code: "failed", message: e.message })),
        Effect.provide(NodeFileSystem.layer),
        Effect.provide(NodePath.layer),
      )

    const typed = (launch: VibestPlugin.Launch) => written(typedLine(launch))

    const argvOf = (launch: VibestPlugin.Launch) =>
      launch.argv.length === 0 || isShellHandoff(launch)
        ? Effect.succeed([])
        : written(launchLine(launch)).pipe(Effect.map((argv) => inLoginShell(shell, argv)))

    const open: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["open"] = (input) =>
      Effect.gen(function* () {
        const targetSocket = input.parent?.socket ?? input.near?.socket ?? deps.socket
        const parentAddress = input.parent?.address
        const project = input.launch.env["VIBEST_PROJECT_ID"]
        const session = input.launch.env["VIBEST_SESSION_ID"]
        const argv = yield* argvOf(input.launch)
        const { VIBEST_EXECUTION: _, ...shellEnv } = input.launch.env

        const runOn = (socket: string, parent: string | undefined) =>
          Effect.gen(function* () {
            const core = yield* coreAt(socket)
            let attempt = 0

            const started = yield* failWith(
              Effect.suspend(() =>
                core.hc.call("terminal.run", {
                  argv: [...argv],
                  name: terminalName(input, attempt++),
                  cwd: input.cwd,
                  env: shellEnv,
                  labels: {
                    [LABEL.runtime]: KIND,
                    [LABEL.seen]: "0",
                    ...(project !== undefined && { [LABEL.project]: project }),
                    ...(session !== undefined && { [LABEL.session]: session }),
                  },
                  keep: true,
                  no_notify: true,
                  ...(parent !== undefined ? { parent, outlive_parent: true } : { no_parent: true }),
                }),
              ).pipe(
                Effect.retry({
                  while: (e) => Predicate.isTagged(e, "HcError") && e.kind === "name_taken",
                  times: 8,
                }),
              ),
            )

            return hcTerminal(socket, started.address, deps.socket)
          })

        if (parentAddress === undefined && targetSocket === deps.socket) return yield* runOn(deps.socket, undefined)

        return yield* runOn(targetSocket, parentAddress).pipe(
          Effect.catchIf(
            (e) =>
              (parentAddress !== undefined && e.code === "not_found") ||
              (targetSocket !== deps.socket && e.code === "unreachable"),
            (e) => runOn(e.code === "unreachable" ? deps.socket : targetSocket, undefined),
          ),
        )
      })

    const send: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["send"] = (terminal, { text, keys }) =>
      Effect.gen(function* () {
        const { hc, address } = yield* reach(terminal)

        if (text !== undefined) yield* failWith(hc.call("terminal.send", { terminal: address, text }))

        if (keys !== undefined && keys.length > 0)
          yield* failWith(hc.call("terminal.keys", { terminal: address, keys: [...keys] }))
      })

    const read: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["read"] = (terminal, lines) =>
      reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) => failWith(hc.call("terminal.read", { terminal: address, lines }))),
        Effect.map((r) => r.text),
      )

    const state: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["state"]> = (terminal) =>
      get(terminal).pipe(
        Effect.flatMap((t) =>
          t.state === "live"
            ? Effect.succeed(agentStateOf(t.status))
            : Effect.fail(
                new RuntimeApi.RuntimeError({
                  code: "not_found",
                  message: `terminal ${formatHcTerminal(terminal)} has finished`,
                }),
              ),
        ),
      )

    const process: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["process"] = (terminal) =>
      get(terminal).pipe(
        Effect.map((t) => {
          if (t.state !== "live")
            return t.exit_code === null || t.exit_code === undefined
              ? { running: false }
              : { running: false, exitCode: t.exit_code }

          if (!atShell(t.foreground)) return { running: true }

          return { running: shellTypedRecently(t.labels, true, Date.now(), typedLaunchMs) }
        }),
      )

    const close: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["close"] = (terminal) =>
      Effect.gen(function* () {
        const { hc, address } = yield* reach(terminal)
        const t = yield* failWith(hc.call("terminal.get", { terminal: address }))

        if (t.state === "live") yield* failWith(hc.call("terminal.kill", { terminal: address }))
        yield* failWith(hc.call("terminal.rm", { terminal: address }))
      }).pipe(
        Effect.catchIf(
          (e) => e.code === "not_found",
          () => Effect.void,
        ),
      )

    const backToShell = (core: Core, address: string, terminal: HcTerminal) =>
      Deferred.make<void>().pipe(
        Effect.flatMap((back) => {
          const waiters = core.waiting.get(address) ?? new Set()
          core.waiting.set(address, waiters.add(back))

          return Effect.gen(function* () {
            const t = yield* failWith(core.hc.call("terminal.get", { terminal: address }))

            if (t.state !== "live")
              return yield* new RuntimeApi.RuntimeError({
                code: "not_found",
                message: `terminal ${formatHcTerminal(terminal)} has finished`,
              })

            if (atShell(t.foreground)) return
            yield* Deferred.await(back).pipe(
              Effect.timeoutOrElse({
                duration: SHELL_WAIT,
                orElse: () =>
                  Effect.fail(
                    new RuntimeApi.RuntimeError({
                      code: "busy",
                      message: `terminal ${formatHcTerminal(terminal)} did not come back to its shell within ${Duration.format(SHELL_WAIT)}`,
                    }),
                  ),
              }),
            )
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                waiters.delete(back)

                if (waiters.size === 0 && core.waiting.get(address) === waiters) core.waiting.delete(address)
              }),
            ),
          )
        }),
      )

    const run: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["run"]> = (terminal, launch) =>
      Effect.gen(function* () {
        const { hc, core, address } = yield* reach(terminal)
        yield* backToShell(core, address, terminal)
        yield* typeLine(hc, address, yield* typed(launch))
        yield* failWith(
          hc.call("terminal.label", { terminal: address, labels: { [LABEL.typed]: String(Date.now()) } }),
        ).pipe(Effect.asVoid)
      })

    const seen: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["seen"]> = (terminal) =>
      get(terminal).pipe(Effect.map(seenOf))

    const see: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["see"]> = (terminal, finished) =>
      reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) =>
          failWith(hc.call("terminal.label", { terminal: address, labels: { [LABEL.seen]: String(finished) } })),
        ),
        Effect.asVoid,
      )

    const present: VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["present"] = (terminal, info) => {
      const session = info[PRESENT_SESSION]
      const project = info[PRESENT_PROJECT_ID]

      if (session === undefined || session === "" || project === undefined || project === "") return Effect.void

      return reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) =>
          failWith(
            hc.call("terminal.label", {
              terminal: address,
              labels: {
                [LABEL.runtime]: KIND,
                [LABEL.project]: project,
                [LABEL.session]: session,
                "herdr.space": "",
                "herdr.tab": "",
                [LABEL.typed]: String(Date.now()),
              },
            }),
          ),
        ),
        Effect.asVoid,
      )
    }

    const attach: NonNullable<VibestPlugin.Runtime.RuntimeDefinition<HcTerminal>["attach"]> = (_target, terminal) => {
      if (terminal === undefined) return []
      const socket = terminal.socket ?? deps.socket

      return ["env", `HC_SOCKET=${socket}`, "hc", "attach", terminal.address]
    }

    return RuntimeApi.define({
      id: KIND,
      ...(deps.name !== undefined && { name: deps.name }),
      ...(deps.caller !== undefined && { caller: deps.caller }),
      ...(deps.link !== undefined && { link: deps.link }),
      ...(deps.locate !== undefined && { locate: deps.locate }),
      terminal: HcTerminal,
      format: formatHcTerminal,
      status,
      open,
      send,
      read,
      process,
      state,
      close,
      run,
      present,
      doctor,
      attach,
      seen,
      see,
      events: RuntimeApi.eventsFrom(events),
    })
  })
