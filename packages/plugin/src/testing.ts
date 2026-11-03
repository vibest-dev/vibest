// `runtimeContract` (runtime-port.md §3): every runtime plugin passes this against a real local instance before it
// ships — the required members first, then each optional member present. Framework-free: it fails with
// `ContractFailure` naming the member and why, so any runner (a test file, a CLI check) can drive it.
import { Cause, Duration, Effect, Exit, Option, Ref, Schema, type Scope, Stream } from "effect"

import type * as Runtime from "./runtime.ts"

export { type Runtime } from "./runtime.ts"

/** One contract violation: the member under test and what it did. */
export class ContractFailure extends Schema.TaggedError<ContractFailure>()("ContractFailure", {
  member: Schema.String,
  message: Schema.String,
}) {}

/** What the contract can fail with: its own violation, or the runtime's error from the call it made. */
export type ContractError = ContractFailure | Runtime.RuntimeError

const fail = (member: string, message: string) => new ContractFailure({ member, message: `runtime ${message}` })
const that = (member: string, ok: boolean, message: string) => (ok ? Effect.void : Effect.fail(fail(member, message)))

/** Poll `read` until `ready` is true, `what` names the wait in the failure. */
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
  /** Where `open` places its terminal (a scratch directory the caller owns). */
  readonly cwd: string
  /** How long one wait may take (default 15 s). */
  readonly timeout?: Duration.Input
}

/**
 * Run the contract: `status`, `open` (argv exactly, env, label), `send` (text and keys), `read`, `process`, `close`,
 * then `state`, `session`, `exec` and `present` when the runtime has them. `prepare` and `attach` are checked as
 * members only: `prepare` changes a machine's setup and `attach` opens the runtime's own interface, so the contract
 * never runs them. `events`, when present, is proven by the `exited` event of the terminal the contract itself closes;
 * `process` on the closed terminal by `not_found` once it is gone, and on a program that ended on its own by
 * `running: false` (its exit code when the runtime knows one). `run`, when present, runs a command in that terminal
 * once its program ended.
 */
export const runtimeContract = (
  runtime: Runtime.Runtime,
  options: ContractOptions,
): Effect.Effect<void, ContractError, Scope.Scope> =>
  Effect.gen(function* () {
    const timeout = Duration.fromInputUnsafe(options.timeout ?? "15 seconds")
    const local: Runtime.Machine = { id: "local" }
    const marker = `vbt-contract-${Math.random().toString(16).slice(2, 8)}`
    // Typed into the shell `open` started, so the read proves the program ran rather than seeing its own typed command echoed.
    const ran = (word: string) => `printf 'vbt-%s-${word}\n' "$VBT_CONTRACT"`

    const shown = yield* runtime.status(local)
    yield* that(
      "status",
      shown.status === "online" || shown.status === "offline" || shown.status === "blocked",
      `reported a status that is not one of online, offline, blocked: ${JSON.stringify(shown)}`,
    )

    // The events follower runs from the start: the program that ends on its own must be seen without anyone closing it.
    const seen = yield* Ref.make<ReadonlyArray<Runtime.RuntimeEvent>>([])
    if (runtime.events !== undefined)
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Ref.update(seen, (events) => [...events, event])),
        Effect.forkScoped,
        Effect.catchCause(() => Effect.void),
      )

    // An interactive shell, driven by `send`: the argv runs exactly, and the env it was given reaches what runs there.
    const terminal = yield* runtime.open(local, {
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

    // Polled: a runtime may take a moment to see the program the terminal is running.
    yield* runtime.send(terminal, { text: "sleep 60", keys: ["enter"] })
    yield* until(
      "process",
      runtime.process(terminal),
      (state) => state.running,
      "did not report the program running while it still sleeps",
      timeout,
    )

    if (runtime.state !== undefined) {
      // `not_found` is a valid answer: the runtime names no agent in a terminal it did not start one in (a plain
      // shell), which core reads as "absent" (§3). Any other answer must be a state of the union.
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

    if (runtime.exec !== undefined) {
      const ran = yield* runtime.exec(local, ["printf", "contract-exec"], options.cwd)
      yield* that(
        "exec",
        ran.code === 0 && ran.output.includes("contract-exec"),
        `printf contract-exec gave code ${ran.code} and ${JSON.stringify(ran.output)}`,
      )
    }

    if (runtime.attach !== undefined) {
      const argv = runtime.attach(local)
      yield* that(
        "attach",
        argv.every((part) => typeof part === "string" && part !== ""),
        "returned something other than a non-empty argv",
      )
    }

    // A program that exits on its own: `process` stops reporting it running (its exit code when the runtime knows
    // one; `not_found` once the terminal went with it) — no `close` ran.
    const ended = yield* runtime.open(local, {
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
    // The terminal is back at its shell: `run` starts the next program there.
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
    if (runtime.events !== undefined)
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
