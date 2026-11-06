import type * as VibestPlugin from "@vibest/plugin"
import { Runtime as RuntimeApi } from "@vibest/plugin"
import { ID, randomId } from "@vibest/schema/id"
import { shellQuote } from "@vibest/schema/layout"
import { Duration, Effect, PubSub, Ref, Schedule, type Scope, Stream } from "effect"
import { type api, type HcFailure, type HcShape, HcTransportError, type Notice } from "effect-hc-sdk"

export type Machine = VibestPlugin.Runtime.Machine
export type Terminal = VibestPlugin.Runtime.Terminal
export type Runtime = VibestPlugin.Runtime.Runtime
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent

export const KIND = "hc"

export const LABEL = {
  runtime: "vibest.runtime",
  project: "vibest.project",
  session: "vibest.session",
  space: "herdr.space",
  tab: "herdr.tab",
} as const

export const PRESENT_MAIN_SESSION = "mainSession"
export const PRESENT_PROJECT_ID = "projectId"

const INTERACTIVE_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "nu"])

export const atShell = (foreground: api.Foreground | null | undefined): boolean => {
  if (foreground === null || foreground === undefined) return false
  const name = foreground.name.replace(/^-/, "").replace(/^.*\//, "")
  return INTERACTIVE_SHELLS.has(name) && foreground.argv.slice(1).every((arg) => arg.startsWith("-"))
}

export const terminalName = (env: Readonly<Record<string, string>>) => {
  const id = env["VIBEST_SESSION_ID"]
  return id !== undefined && ID.test(id)
    ? `s-${id.replaceAll("-", "").slice(0, 30)}`
    : `vbt-${randomId().replaceAll("-", "").slice(0, 28)}`
}

export const runtimeEnv = (machine: string, name: string) => JSON.stringify({ runtime: KIND, machine, terminal: name })

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
const SHELL_POLL = Schedule.spaced("300 millis")
const RESUBSCRIBE = Schedule.spaced("2 seconds")

const EXIT_EVENTS = new Set(["finished", "removed", "lost"])

export const make = (deps: { readonly hc: HcShape; readonly scope: Scope.Scope }): Effect.Effect<Runtime> =>
  Effect.gen(function* () {
    const { hc, scope } = deps
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    const names = new Map<string, string>()
    const busy = new Set<string>()
    const subscribed = yield* Ref.make(false)

    const terminalOf = (address: string): Terminal => ({ machine: "local", id: names.get(address) ?? address })
    const track = (t: api.Terminal) => {
      if (t.name !== null && t.name !== undefined) names.set(t.address, t.name)
      if (t.state === "live" && t.foreground && !atShell(t.foreground)) busy.add(t.address)
    }
    const exited = (address: string) => {
      busy.delete(address)
      return PubSub.publish(events, { type: "exited", terminal: terminalOf(address) })
    }

    const onNotice = (notice: Notice): Effect.Effect<void, HcFailure> => {
      if (notice._tag === "Subscribed")
        return Effect.gen(function* () {
          busy.clear()
          for (const t of notice.result.terminals) track(t)
          if (yield* Ref.getAndSet(subscribed, true)) yield* PubSub.publish(events, { type: "reset", machine: "local" })
        })
      if (notice._tag === "Notification")
        return notice.method === "missed"
          ? Effect.fail(new HcTransportError({ method: "events.subscribe", message: "missed events" }))
          : Effect.void
      const { type, terminal, data } = notice.event
      if (type === "created") {
        track(data as api.Terminal)
        return Effect.void
      }
      if (EXIT_EVENTS.has(type)) return exited(terminal)
      if (type === "foreground") {
        if (!atShell(data as api.Foreground)) {
          busy.add(terminal)
          return Effect.void
        }
        return busy.has(terminal) ? exited(terminal) : Effect.void
      }
      return Effect.void
    }

    yield* hc
      .subscribe({ labels: { [LABEL.runtime]: KIND } })
      .pipe(
        Stream.runForEach(onNotice),
        Effect.andThen(Effect.fail({ message: "the event stream ended" })),
        Effect.retry(RESUBSCRIBE),
        Effect.forkIn(scope),
      )

    const get = (terminal: Terminal) => failWith(hc.call("terminal.get", { terminal: terminal.id }))

    const status: Runtime["status"] = () =>
      hc.hello.pipe(
        Effect.as({ status: "online" as const }),
        Effect.catch((e) =>
          Effect.succeed(
            e._tag === "HcGenerationMismatch"
              ? { status: "blocked" as const, reason: e.message }
              : {
                  status: "offline" as const,
                  reason: `no herdr-core answers at ${hc.socketPath} (start one with hc server start)`,
                },
          ),
        ),
      )

    const typeLine = (name: string, argv: ReadonlyArray<string>) =>
      failWith(hc.call("terminal.send", { terminal: name, text: argv.map(shellQuote).join(" ") })).pipe(Effect.asVoid)

    const open: Runtime["open"] = (machine, input) =>
      Effect.gen(function* () {
        const name = terminalName(input.env)
        const project = input.env["VIBEST_PROJECT_ID"]
        const session = input.env["VIBEST_SESSION_ID"]
        yield* failWith(
          hc.call("terminal.run", {
            name,
            cwd: input.cwd,
            env: { ...input.env, VIBEST_RUNTIME: runtimeEnv(machine.id, name) },
            labels: {
              [LABEL.runtime]: KIND,
              ...(project !== undefined ? { [LABEL.project]: project } : {}),
              ...(session !== undefined ? { [LABEL.session]: session } : {}),
            },
            keep: true,
            no_notify: true,
            ...(input.near !== undefined ? { parent: input.near.id, outlive_parent: true } : { no_parent: true }),
          }),
        )
        const terminal: Terminal = { machine: machine.id, id: name }
        if (input.argv.length > 0)
          yield* typeLine(name, input.argv).pipe(Effect.tapError(() => close(terminal).pipe(Effect.ignore)))
        return terminal
      })

    const send: Runtime["send"] = (terminal, { text, keys }) =>
      Effect.gen(function* () {
        if (text !== undefined) yield* failWith(hc.call("terminal.send", { terminal: terminal.id, text }))
        if (keys !== undefined && keys.length > 0)
          yield* failWith(hc.call("terminal.keys", { terminal: terminal.id, keys: [...keys] }))
      })

    const read: Runtime["read"] = (terminal, lines) =>
      failWith(hc.call("terminal.read", { terminal: terminal.id, lines })).pipe(Effect.map((r) => r.text))

    const process: Runtime["process"] = (terminal) =>
      get(terminal).pipe(
        Effect.map((t) =>
          t.state === "live"
            ? { running: !atShell(t.foreground) }
            : t.exit_code === null || t.exit_code === undefined
              ? { running: false }
              : { running: false, exitCode: t.exit_code },
        ),
      )

    const close: Runtime["close"] = (terminal) =>
      Effect.gen(function* () {
        const t = yield* get(terminal)
        if (t.state === "live") yield* failWith(hc.call("terminal.kill", { terminal: terminal.id }))
        yield* failWith(hc.call("terminal.rm", { terminal: terminal.id }))
      }).pipe(
        Effect.catchIf(
          (e) => e.code === "not_found",
          () => Effect.void,
        ),
      )

    const run: NonNullable<Runtime["run"]> = (terminal, argv) =>
      Effect.gen(function* () {
        const idle = yield* get(terminal).pipe(
          Effect.flatMap((t) =>
            t.state === "live"
              ? Effect.succeed(atShell(t.foreground))
              : Effect.fail(
                  new RuntimeApi.RuntimeError({ code: "not_found", message: `terminal ${terminal.id} has finished` }),
                ),
          ),
          Effect.repeat({ until: (ok) => ok, schedule: SHELL_POLL }),
          Effect.timeoutOrElse({ duration: SHELL_WAIT, orElse: () => Effect.succeed(false) }),
        )
        if (!idle)
          return yield* new RuntimeApi.RuntimeError({
            code: "busy",
            message: `terminal ${terminal.id} did not come back to its shell within ${Duration.format(SHELL_WAIT)}`,
          })
        yield* typeLine(terminal.id, argv)
      })

    const present: Runtime["present"] = (terminal, info) => {
      const main = info[PRESENT_MAIN_SESSION]
      const project = info[PRESENT_PROJECT_ID]
      if (main === undefined || main === "" || project === undefined || project === "") return Effect.void
      return failWith(
        hc.call("terminal.label", {
          terminal: terminal.id,
          labels: {
            [LABEL.project]: project,
            [LABEL.session]: main,
            [LABEL.space]: project,
            [LABEL.tab]: main,
          },
        }),
      ).pipe(Effect.asVoid)
    }

    return {
      kind: KIND,
      status,
      open,
      send,
      read,
      process,
      close,
      run,
      present,
      events: Stream.fromPubSub(events),
    } satisfies Runtime
  })
