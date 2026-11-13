import { Cause, Duration, Effect, Exit, Option, Ref, Schema, type Scope, Stream } from "effect"

import type { MachineEvent, MachineHooks, MachineNote } from "./effect/index.ts"
import type { Plugin } from "./effect/plugin.ts"
import type * as Runtime from "./effect/runtime.ts"

export type { RuntimeDefinition } from "./effect/runtime.ts"

export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  member: Schema.String,
  message: Schema.String,
}) {}

export type ContractError = ContractFailure | Runtime.RuntimeError

const fail = (member: string, message: string) => new ContractFailure({ member, message: `runtime ${message}` })
const that = (member: string, ok: boolean, message: string) => (ok ? Effect.void : Effect.fail(fail(member, message)))

const until = <A, E, R>(
  member: string,
  read: Effect.Effect<A, E, R>,
  ready: (value: A) => boolean,
  what: string,
  timeout: Duration.Duration,
) =>
  Effect.gen(function* () {
    const deadline = Date.now() + Duration.toMillis(timeout)
    for (;;) {
      const value = yield* read
      if (ready(value)) return value
      if (Date.now() >= deadline) return yield* Effect.fail(fail(member, `${what} within ${Duration.format(timeout)}`))
      yield* Effect.sleep("100 millis")
    }
  })

export interface ContractOptions {
  readonly cwd: string
  readonly timeout?: Duration.Input
}

export const runtimeContract = (
  runtime: Runtime.RuntimeDefinition,
  options: ContractOptions,
): Effect.Effect<void, ContractError, Scope.Scope> =>
  Effect.gen(function* () {
    const timeout = Duration.fromInputUnsafe(options.timeout ?? "15 seconds")
    const marker = `vbt-contract-${Math.random().toString(16).slice(2, 8)}`
    const ran = (word: string) => `printf 'vbt-%s-${word}\n' "$VBT_CONTRACT"`

    const shown = yield* runtime.status()
    yield* that(
      "status",
      shown.status === "online" || shown.status === "offline" || shown.status === "blocked",
      `reported a status that is not one of online, offline, blocked: ${JSON.stringify(shown)}`,
    )

    const seen = yield* Ref.make<ReadonlyArray<Runtime.RuntimeEvent>>([])
    yield* runtime.events.pipe(
      Stream.runForEach((event) => Ref.update(seen, (events) => [...events, event])),
      Effect.forkScoped,
      Effect.catchCause(() => Effect.void),
    )

    const terminal = yield* runtime.open({
      project: options.cwd,
      cwd: options.cwd,
      argv: ["/bin/sh"],
      env: { VBT_CONTRACT: marker },
      label: `vibest contract ${marker}`,
    })
    yield* that("open", typeof terminal.id === "string" && terminal.id !== "", "returned a terminal without an id")

    yield* runtime.send(terminal, { text: ran("sent"), keys: ["enter"] })
    yield* until(
      "send",
      runtime.read(terminal, 40),
      (out) => out.includes(`vbt-${marker}-sent`),
      "did not run the text typed with send",
      timeout,
    )

    yield* runtime.send(terminal, { text: "sleep 60", keys: ["enter"] })
    yield* until(
      "process",
      runtime.process(terminal),
      (state) => state.running,
      "did not report the program running while it still sleeps",
      timeout,
    )

    if (runtime.state !== undefined) {
      const state = yield* runtime
        .state(terminal)
        .pipe(
          Effect.catchTag("RuntimeError", (e) =>
            e.code === "not_found" ? Effect.succeed("absent" as const) : Effect.fail(e),
          ),
        )
      yield* that(
        "state",
        state === "absent" || state === "idle" || state === "working" || state === "blocked" || state === "unknown",
        `reported a state that is not one of idle, working, blocked, unknown: ${JSON.stringify(state)}`,
      )
    }

    if (runtime.session !== undefined) {
      const session = yield* runtime.session(terminal)
      yield* that(
        "session",
        session === null || typeof session === "string",
        `returned something other than a conversation id or null: ${JSON.stringify(session)}`,
      )
    }

    if (runtime.present !== undefined) yield* runtime.present(terminal, { contract: marker })

    if (runtime.attach !== undefined) {
      const argv = runtime.attach(undefined)
      yield* that(
        "attach",
        argv.every((part) => typeof part === "string" && part !== ""),
        "returned something other than a non-empty argv",
      )
    }

    const ended = yield* runtime.open({
      project: options.cwd,
      cwd: options.cwd,
      argv: ["/bin/sh", "-c", "exit 3"],
      env: { VBT_CONTRACT: marker },
      label: `vibest contract ${marker} exit`,
    })
    const gone = yield* until(
      "process",
      runtime.process(ended).pipe(Effect.exit),
      (exit) => {
        if (Exit.isFailure(exit)) {
          const error = Cause.squash(exit.cause) as { readonly code?: string }
          return error.code === "not_found"
        }
        return !exit.value.running
      },
      "did not report the exited program not running",
      timeout,
    )
    if (Exit.isSuccess(gone) && gone.value.exitCode !== undefined)
      yield* that(
        "process",
        gone.value.exitCode === 3,
        `reported exit code ${gone.value.exitCode} for a program that ran exit 3`,
      )
    if (runtime.run !== undefined && Exit.isSuccess(gone)) {
      yield* runtime.run(ended, ["/bin/sh", "-c", ran("again")])
      yield* until(
        "run",
        runtime.read(ended, 40),
        (out) => out.includes(`vbt-${marker}-again`),
        "did not run the command in the terminal whose program ended",
        timeout,
      )
    }
    if (Exit.isSuccess(gone)) yield* runtime.close(ended)

    yield* runtime.close(terminal)
    yield* until(
      "events",
      Ref.get(seen),
      (events) => events.some((event) => event.type === "exited" && event.terminal.id === terminal.id),
      `emitted no exited event for the closed terminal ${terminal.id}`,
      timeout,
    )

    yield* until(
      "process",
      runtime.process(terminal).pipe(Effect.flip, Effect.option),
      (found) => Option.isSome(found) && found.value.code === "not_found",
      `kept answering process for the closed terminal ${terminal.id} instead of not_found`,
      Duration.fromInputUnsafe("5 seconds"),
    )
  }).pipe(Effect.asVoid)

export const machineHooks = (
  plugin: Plugin,
  options: Readonly<Record<string, unknown>> = {},
): Effect.Effect<
  {
    readonly runtimes: ReadonlyArray<Runtime.RuntimeDefinition>
    readonly fire: (
      hook: keyof MachineHooks,
      event: MachineEvent,
      runtime?: string,
    ) => Effect.Effect<ReadonlyArray<MachineNote>>
  },
  never,
  Scope.Scope
> =>
  Effect.gen(function* () {
    const runtimes: Array<Runtime.RuntimeDefinition> = []
    const hooks: Array<{
      readonly name: string
      readonly runtime: string | undefined
      readonly callback: (event: MachineEvent) => Effect.Effect<ReadonlyArray<MachineNote> | void>
    }> = []
    const editor: Runtime.RuntimeEditor = {
      list: () => runtimes,
      get: (id) => runtimes.find((definition) => definition.id === id),
      add: (definition) => {
        const at = runtimes.findIndex((existing) => existing.id === definition.id)
        if (at === -1) runtimes.push(definition)
        else runtimes[at] = definition
      },
      update: (id, update) => {
        const at = runtimes.findIndex((definition) => definition.id === id)
        if (at === -1) return
        const copy = { ...runtimes[at]! }
        update(copy)
        runtimes[at] = copy
      },
      remove: (id) => {
        const at = runtimes.findIndex((definition) => definition.id === id)
        if (at !== -1) runtimes.splice(at, 1)
      },
    }
    const registration = { dispose: Effect.void }
    yield* plugin.effect({
      options,
      agent: { hook: () => Effect.succeed(registration), transform: () => Effect.succeed(registration) },
      machine: {
        hook: (name, callback, hookOptions) =>
          name === "connect" || name === "remove"
            ? Effect.sync(() => {
                hooks.push({ name, runtime: hookOptions?.runtime, callback })
                return registration
              })
            : Effect.die(new Error(`unsupported hook machine.${String(name)}`)),
      },
      runtime: { transform: (f) => Effect.sync(() => (f(editor), registration)), reload: () => Effect.void },
      harness: { transform: () => Effect.succeed(registration), reload: () => Effect.void },
      subscription: { report: () => Effect.void },
      event: { subscribe: () => Stream.empty },
    })
    return {
      runtimes,
      fire: (hook, input, runtime) =>
        Effect.gen(function* () {
          const notes: Array<MachineNote> = []
          for (const entry of hooks)
            if (
              entry.name === hook &&
              (runtime === undefined || entry.runtime === undefined || entry.runtime === runtime)
            )
              notes.push(...((yield* entry.callback(Object.freeze({ ...input }))) ?? []))
          return notes
        }),
    }
  })
