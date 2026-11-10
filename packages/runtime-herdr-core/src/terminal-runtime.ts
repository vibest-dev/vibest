import type * as VibestPlugin from "@vibest/plugin"
import { Runtime as RuntimeApi } from "@vibest/plugin"
import { ID, shortId } from "@vibest/schema/id"
import { shellQuote } from "@vibest/schema/layout"
import { Deferred, Duration, Effect, PubSub, type Scope, Stream } from "effect"
import { type api, type HcFailure, type HcShape, HcTransportError, type Notice } from "effect-herdr-core-sdk"

export type Machine = VibestPlugin.Runtime.Machine
export type Terminal = VibestPlugin.Runtime.Terminal
export type Runtime = VibestPlugin.Runtime.RuntimeDefinition
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent
export type AgentState = VibestPlugin.Runtime.AgentState

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
  space: "herdr.space",
  tab: "herdr.tab",
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
  return { turn: t.turn ?? 0, seen }
}

export const PRESENT_MAIN_SESSION = "mainSession"
export const PRESENT_PROJECT_ID = "projectId"

const INTERACTIVE_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

export const atShell = (foreground: api.Foreground | null | undefined): boolean => {
  if (foreground === null || foreground === undefined) return false
  const name = foreground.name.replace(/^-/, "").replace(/^.*\//, "")
  return INTERACTIVE_SHELLS.has(name) && foreground.argv.slice(1).every((arg) => arg.startsWith("-"))
}

const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

export const terminalName = (input: Parameters<Runtime["open"]>[1], attempt = 0) => {
  const id = input.env["VIBEST_SESSION_ID"]
  const session = id !== undefined && ID.test(id) ? id : undefined
  const title =
    session !== undefined && input.label.startsWith(`${shortId(session)} `)
      ? input.label.slice(shortId(session).length + 1)
      : input.label
  const base =
    session !== undefined
      ? slug(title) || slug(input.env["VIBEST_HARNESS"] ?? "") || "agent"
      : slug(
          input.project
            .replace(/[\\/]+$/, "")
            .split(/[\\/]/)
            .at(-1) ?? "",
        )
  const suffix = `${session?.slice(0, 4) ?? "main"}${attempt === 0 ? "" : `-${attempt + 1}`}`
  return `${base ? `${base.slice(0, 31 - suffix.length).replace(/-+$/, "")}-` : ""}${suffix}`
}

export const terminalId = (socket: string, address: string) => `${address}@${socket}`

export const parseTerminalId = (id: string, fallbackSocket: string) => {
  const at = id.indexOf("@")
  return at < 0 ? { socket: fallbackSocket, address: id } : { socket: id.slice(at + 1), address: id.slice(0, at) }
}

const NOT_FOUND_KINDS = new Set(["not_found", "finished", "machine_unknown"])

export const failure = (error: HcFailure | { readonly message: string }): RuntimeApi.RuntimeError => {
  const tag = (error as { readonly _tag?: string })._tag
  if (tag === "HcTransportError") return new RuntimeApi.RuntimeError({ code: "unreachable", message: error.message })
  if (tag === "HcError") {
    const { kind, method } = error as { readonly kind: string; readonly method: string }
    const code = NOT_FOUND_KINDS.has(kind) ? "not_found" : kind === "blocked" ? "busy" : "failed"
    return new RuntimeApi.RuntimeError({ code, message: `${method}: ${error.message}` })
  }
  return new RuntimeApi.RuntimeError({ code: "failed", message: error.message })
}

const failWith = <A, R>(effect: Effect.Effect<A, HcFailure, R>) => effect.pipe(Effect.mapError(failure))

const SHELL_WAIT = Duration.seconds(30)
export const FOLLOW_ATTEMPTS = 8

export const followBackoff = (failures: number) =>
  Duration.millis(Math.min(500 * 2 ** Math.max(failures - 1, 0), 30_000))

const EXIT_EVENTS = new Set(["finished", "removed", "lost"])

type Core = {
  readonly hc: HcShape
  readonly busy: Set<string>
  readonly waiting: Map<string, Set<Deferred.Deferred<void>>>
}

export const make = (deps: {
  readonly connect: (socketPath: string) => Effect.Effect<HcShape>
  readonly socket: string
  readonly scope: Scope.Scope
  readonly typedLaunch?: Duration.Input
}): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const { connect, scope } = deps
    const typedLaunchMs = Duration.toMillis(deps.typedLaunch ?? Duration.millis(TYPED_LAUNCH_MS))
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    const cores = new Map<string, Core>()
    const home = yield* connect(deps.socket)

    const wake = (core: Core, address: string) =>
      Effect.forEach(core.waiting.get(address) ?? [], (waiter) => Deferred.succeed(waiter, undefined), {
        discard: true,
      })
    const exited = (socket: string, core: Core, address: string) => {
      core.busy.delete(address)
      return wake(core, address).pipe(
        Effect.andThen(
          PubSub.publish(events, { type: "exited", terminal: { machine: "local", id: terminalId(socket, address) } }),
        ),
      )
    }
    const track = (core: Core, t: api.Terminal) => {
      if (t.state === "live" && t.foreground && !atShell(t.foreground)) core.busy.add(t.address)
    }

    const onNotice = (socket: string, core: Core, notice: Notice): Effect.Effect<void, HcFailure> => {
      if (notice._tag === "Subscribed")
        return Effect.gen(function* () {
          core.busy.clear()
          for (const t of notice.result.terminals) track(core, t)
          for (const t of notice.result.terminals) if (!core.busy.has(t.address)) yield* wake(core, t.address)
          yield* PubSub.publish(events, { type: "reset", machine: "local" })
        })
      if (notice._tag === "Notification")
        return notice.method === "missed"
          ? Effect.fail(new HcTransportError({ method: "events.subscribe", message: "missed events" }))
          : Effect.void
      const { type, terminal, data } = notice.event
      if (type === "created") {
        track(core, data as api.Terminal)
        return Effect.void
      }
      if (EXIT_EVENTS.has(type)) return exited(socket, core, terminal)
      if (type === "status") {
        const state = agentStateOf((data as { readonly status?: api.Status | null }).status)
        return state === "unknown"
          ? Effect.void
          : PubSub.publish(events, {
              type: "state",
              terminal: { machine: "local", id: terminalId(socket, terminal) },
              state,
            })
      }
      if (SEEN_EVENTS.has(type))
        return PubSub.publish(events, {
          type: "seen",
          terminal: { machine: "local", id: terminalId(socket, terminal) },
        })
      if (type === "foreground") {
        if (!atShell(data as api.Foreground)) {
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
        while (failures < FOLLOW_ATTEMPTS) {
          let subscribed = false
          yield* core.hc.subscribe({ labels: { [LABEL.runtime]: KIND } }).pipe(
            Stream.runForEach((notice) =>
              onNotice(socket, core, notice).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (notice._tag === "Subscribed") subscribed = true
                  }),
                ),
              ),
            ),
            Effect.ignore,
          )
          if (subscribed) yield* PubSub.publish(events, { type: "reset", machine: "local" })
          failures = subscribed ? 1 : failures + 1
          yield* Effect.sleep(followBackoff(failures))
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

    const reach = (terminal: Terminal) =>
      Effect.gen(function* () {
        const { socket, address } = parseTerminalId(terminal.id, deps.socket)
        const core = yield* coreAt(socket)
        return { hc: core.hc, core, socket, address }
      })

    const get = (terminal: Terminal) =>
      reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) => failWith(hc.call("terminal.get", { terminal: address }))),
      )

    const status: Runtime["status"] = () =>
      home.hello.pipe(
        Effect.as({ status: "online" as const }),
        Effect.catch((e) =>
          Effect.succeed(
            e._tag === "HcGenerationMismatch" || e._tag === "HcCoreTooOld" || e._tag === "HcMethodsMissing"
              ? { status: "blocked" as const, reason: e.message }
              : {
                  status: "offline" as const,
                  reason: `no herdr-core answers at ${home.socketPath} (start one with hc server start)`,
                },
          ),
        ),
      )

    const typeLine = (hc: HcShape, address: string, argv: ReadonlyArray<string>) =>
      failWith(hc.call("terminal.send", { terminal: address, text: argv.map(shellQuote).join(" ") })).pipe(
        Effect.asVoid,
      )

    const open: Runtime["open"] = (machine, input) =>
      Effect.gen(function* () {
        const near = input.near !== undefined ? parseTerminalId(input.near.id, deps.socket) : undefined
        const socket = near?.socket ?? deps.socket
        const core = yield* coreAt(socket)
        const hc = core.hc
        const project = input.env["VIBEST_PROJECT_ID"]
        const session = input.env["VIBEST_SESSION_ID"]
        let attempt = 0
        const started = yield* failWith(
          Effect.suspend(() =>
            hc.call("terminal.run", {
              name: terminalName(input, attempt++),
              cwd: input.cwd,
              env: { ...input.env },
              labels: {
                [LABEL.runtime]: KIND,
                [LABEL.seen]: "0",
                ...(project !== undefined ? { [LABEL.project]: project } : {}),
                ...(session !== undefined ? { [LABEL.session]: session } : {}),
                ...(input.argv.length > 0 ? { [LABEL.typed]: String(Date.now()) } : {}),
              },
              keep: true,
              no_notify: true,
              ...(near !== undefined ? { parent: near.address, outlive_parent: true } : { no_parent: true }),
            }),
          ).pipe(
            Effect.retry({
              while: (e) => e._tag === "HcError" && e.kind === "name_taken",
              times: 8,
            }),
          ),
        )
        const terminal: Terminal = { machine: machine.id, id: terminalId(socket, started.address) }
        if (input.argv.length > 0) {
          yield* typeLine(hc, started.address, input.argv).pipe(
            Effect.tapError(() => close(terminal).pipe(Effect.ignore)),
          )
        }
        return terminal
      })

    const send: Runtime["send"] = (terminal, { text, keys }) =>
      Effect.gen(function* () {
        const { hc, address } = yield* reach(terminal)
        if (text !== undefined) yield* failWith(hc.call("terminal.send", { terminal: address, text }))
        if (keys !== undefined && keys.length > 0)
          yield* failWith(hc.call("terminal.keys", { terminal: address, keys: [...keys] }))
      })

    const read: Runtime["read"] = (terminal, lines) =>
      reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) => failWith(hc.call("terminal.read", { terminal: address, lines }))),
        Effect.map((r) => r.text),
      )

    const state: NonNullable<Runtime["state"]> = (terminal) =>
      get(terminal).pipe(
        Effect.flatMap((t) =>
          t.state === "live"
            ? Effect.succeed(agentStateOf(t.status))
            : Effect.fail(
                new RuntimeApi.RuntimeError({ code: "not_found", message: `terminal ${terminal.id} has finished` }),
              ),
        ),
      )

    const process: Runtime["process"] = (terminal) =>
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

    const close: Runtime["close"] = (terminal) =>
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

    const backToShell = (core: Core, address: string, terminal: Terminal) =>
      Deferred.make<void>().pipe(
        Effect.flatMap((back) => {
          const waiters = core.waiting.get(address) ?? new Set()
          core.waiting.set(address, waiters.add(back))
          return Effect.gen(function* () {
            const t = yield* failWith(core.hc.call("terminal.get", { terminal: address }))
            if (t.state !== "live")
              return yield* new RuntimeApi.RuntimeError({
                code: "not_found",
                message: `terminal ${terminal.id} has finished`,
              })
            if (atShell(t.foreground)) return
            yield* Deferred.await(back).pipe(
              Effect.timeoutOrElse({
                duration: SHELL_WAIT,
                orElse: () =>
                  Effect.fail(
                    new RuntimeApi.RuntimeError({
                      code: "busy",
                      message: `terminal ${terminal.id} did not come back to its shell within ${Duration.format(SHELL_WAIT)}`,
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

    const run: NonNullable<Runtime["run"]> = (terminal, argv) =>
      Effect.gen(function* () {
        const { hc, core, address } = yield* reach(terminal)
        yield* backToShell(core, address, terminal)
        yield* typeLine(hc, address, argv)
        yield* failWith(
          hc.call("terminal.label", { terminal: address, labels: { [LABEL.typed]: String(Date.now()) } }),
        ).pipe(Effect.asVoid)
      })

    const seen: NonNullable<Runtime["seen"]> = (terminal) => get(terminal).pipe(Effect.map(seenOf))

    const see: NonNullable<Runtime["see"]> = (terminal, turn) =>
      reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) =>
          failWith(hc.call("terminal.label", { terminal: address, labels: { [LABEL.seen]: String(turn) } })),
        ),
        Effect.asVoid,
      )

    const present: Runtime["present"] = (terminal, info) => {
      const main = info[PRESENT_MAIN_SESSION]
      const project = info[PRESENT_PROJECT_ID]
      if (main === undefined || main === "" || project === undefined || project === "") return Effect.void
      return reach(terminal).pipe(
        Effect.flatMap(({ hc, address }) =>
          failWith(
            hc.call("terminal.label", {
              terminal: address,
              labels: {
                [LABEL.runtime]: KIND,
                [LABEL.project]: project,
                [LABEL.session]: main,
                [LABEL.space]: project,
                [LABEL.tab]: main,
              },
            }),
          ),
        ),
        Effect.asVoid,
      )
    }

    return {
      id: KIND,
      status,
      open,
      send,
      read,
      process,
      state,
      close,
      run,
      present,
      seen,
      see,
      events: Stream.fromPubSub(events),
    } satisfies Runtime
  })
