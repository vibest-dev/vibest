import * as VibestPlugin from "@vibest/plugin"
import { NoRuntime } from "@vibest/schema/session"
// The runtime registry (runtime-port.md §1–§4): what runtime plugins register through `context.runtime.register`, and
// how core routes every call by the runtime kind stored on a row. Core never branches on a runtime's `kind` beyond
// checking it is loaded and online; which runtime a start uses is the choice plugin's decision (§4).
import { Cause, Context, Effect, FileSystem, Layer, PubSub, type Scope, Stream } from "effect"

import { Bus, type LiveEvent } from "./bus.ts"

export { NoRuntime }

export type Runtime = VibestPlugin.Runtime.Runtime
export type Machine = VibestPlugin.Runtime.Machine
export type MachineStatus = VibestPlugin.Runtime.MachineStatus
export type Terminal = VibestPlugin.Runtime.Terminal
export type AgentState = VibestPlugin.Runtime.AgentState
export type RuntimeError = VibestPlugin.Runtime.RuntimeError
export const RuntimeError = VibestPlugin.Runtime.RuntimeError
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent

/** The registry's shape: what runtime plugins register into and core routes through. */
export interface RuntimesShape {
  /** Register for the plugin's lifetime: the scope that runs this removes the runtime when it closes. A duplicate `kind` is a defect (unique among loaded plugins). */
  readonly register: (runtime: Runtime) => Effect.Effect<void, never, Scope.Scope>
  /** Every runtime registered right now, in registration order. */
  readonly all: Effect.Effect<ReadonlyArray<Runtime>>
  /** The runtime for `kind`, refusing with `NoRuntime` when no loaded plugin registered it. */
  readonly route: (kind: string) => Effect.Effect<Runtime, NoRuntime>
  /** Every registered runtime's `events`, merged; each registration's share ends when it unloads. */
  readonly events: Stream.Stream<RuntimeEvent>
  /**
   * Every runtime's status on `machine`, in registration order: what `agent.start.before` reports as `machines[]`
   * (§7) and what the choice plugin decides on.
   */
  readonly statuses: (
    machine: Machine,
  ) => Effect.Effect<ReadonlyArray<{ readonly runtime: Runtime; readonly status: MachineStatus }>>
  /** `machine`'s status of `runtime`: online, or the reason it is not (§4's check after the chain). */
  readonly online: (runtime: Runtime, machine: Machine) => Effect.Effect<void, NoRuntime>
}

const live = (kind: string, event: RuntimeEvent): LiveEvent => {
  switch (event.type) {
    case "state":
      return { type: "live.state", runtime: kind, terminal: event.terminal, state: event.state }
    case "exited":
      return { type: "live.exited", runtime: kind, terminal: event.terminal }
    case "reset":
      return { type: "live.reset", runtime: kind, machine: event.machine }
  }
}

const make = (initial: ReadonlyArray<Runtime> = []): Effect.Effect<RuntimesShape, never, Bus | Scope.Scope> =>
  Effect.gen(function* () {
    const bus = yield* Bus
    // The plugin host registers and unregisters sequentially (one supervisor consumer), so one slot is enough.
    let registered: ReadonlyArray<Runtime> = initial
    // Kept only until its consumers move to the Bus (plan step 5). Both streams carry these events until then: a transition, not the design.
    const events = yield* PubSub.unbounded<RuntimeEvent>()
    /** A runtime's events into the merged stream, for this registry's lifetime (a registration's ends with its scope). */
    const merge = (runtime: Runtime, scope: Scope.Scope) =>
      runtime.events === undefined
        ? Effect.void
        : runtime.events.pipe(
            Stream.runForEach((event) =>
              PubSub.publish(events, event).pipe(Effect.andThen(bus.observe(live(runtime.kind, event)))),
            ),
            Effect.catchCause(() => Effect.void),
            Effect.forkIn(scope),
          )
    // Runtimes seeded at make (a test's fake, registered up front) merge for the registry's own scope.
    const own = yield* Effect.scope
    for (const runtime of initial) yield* merge(runtime, own)
    return {
      register: (runtime) =>
        Effect.gen(function* () {
          yield* Effect.sync(() => {
            if (registered.some((loaded) => loaded.kind === runtime.kind))
              throw new Error(`runtime kind "${runtime.kind}" is already registered`)
            registered = [...registered, runtime]
          })
          // This registration's events end with its scope: the fiber dies when the plugin unloads.
          yield* merge(runtime, yield* Effect.scope)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registered = registered.filter((loaded) => loaded !== runtime)
            }),
          )
          // This phase has one machine. A later runtime with several publishes one reset per machine.
          yield* bus.observe({ type: "live.reset", runtime: runtime.kind, machine: "local" })
        }),
      all: Effect.sync(() => registered),
      route: (kind) =>
        Effect.suspend(() => {
          const found = registered.find((runtime) => runtime.kind === kind)
          return found === undefined
            ? Effect.fail(
                new NoRuntime({
                  message: `the runtime "${kind}" is not loaded${registered.length === 0 ? "" : `; loaded: ${registered.map((runtime) => runtime.kind).join(", ")}`}`,
                }),
              )
            : Effect.succeed(found)
        }),
      events: Stream.fromPubSub(events),
      statuses: (machine) =>
        Effect.forEach(
          registered,
          (runtime) => runtime.status(machine).pipe(Effect.map((status) => ({ runtime, status }))),
          { concurrency: "unbounded" },
        ),
      online: (runtime, machine) =>
        runtime.status(machine).pipe(
          Effect.flatMap((status) =>
            status.status === "online"
              ? Effect.void
              : Effect.fail(
                  new NoRuntime({
                    message: `the runtime ${runtime.kind} is ${status.status} on ${machine.id}${"reason" in status ? ` (${status.reason})` : ""}`,
                  }),
                ),
          ),
          Effect.catchCause((cause) =>
            Effect.fail(
              new NoRuntime({
                message: `the runtime ${runtime.kind}'s status on ${machine.id} could not be read: ${messageOf(cause)}`,
              }),
            ),
          ),
        ),
    }
  })

/** A failure's message, whatever shape it is (plugins.ts `errorMessage` without the import cycle). */
const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

/**
 * One registry per host that loads runtime plugins: provided beside `Plugins.layer` in daemon.ts (a Service, never a
 * global, so two hosts in one process each get their own). Tests that never load a runtime plugin provide an empty one.
 */
export class Runtimes extends Context.Service<Runtimes, RuntimesShape>()("vibest/Runtimes") {
  static readonly layer = Layer.effect(Runtimes, make())
}

/** A fresh registry, for a host that wants its own scope of runtimes (tests build one per daemon, with their fake registered up front). */
export const registry = make

/**
 * `readFile(machine, path)` (runtime-port.md §3): on `local` the file system; on another machine the runtime's `exec`,
 * which without one is the hidden-terminal fallback. Reading is what result reports need (§5). This phase has `local`.
 */
export const readFile = (machine: Machine, file: string): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (machine.id !== "local")
      return yield* Effect.fail(new Error(`reading ${file} on machine ${machine.id} is not supported yet`))
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file)
  }).pipe(Effect.mapError((e) => new Error(`read ${file}: ${e.message}`)))

/** What core can tell of an agent in a terminal (§5): its state when the runtime has `state`, "absent" when the runtime names no agent there. */
export type AgentSeen = AgentState | "absent"

/** The state of what `agentState` saw, undefined when it could not tell (absent; `"unknown"` is the runtime's own no-answer). */
export const stateOf = (seen: AgentSeen): AgentState | undefined => (seen === "absent" ? undefined : seen)

/** The agent's state as the runtime sees it (§3 `state`, [vibest's harness integration only] when absent). */
export const agentState = (h: Runtime, terminal: Terminal): Effect.Effect<AgentSeen, RuntimeError> =>
  h.state === undefined
    ? Effect.succeed("unknown")
    : h.state(terminal).pipe(
        // not_found: no agent there. Unreachable is no answer at all (§3: transient, the caller retries); anything else reads as unknown.
        Effect.catchTag("RuntimeError", (error) =>
          error.code === "not_found"
            ? Effect.succeed("absent" as AgentSeen)
            : error.code === "unreachable"
              ? Effect.fail(error)
              : Effect.succeed("unknown" as AgentSeen),
        ),
      )

/** Whether a program still runs in the terminal (§5's fallback when there is no `state`): `not_found` is not running; an error that cannot tell counts as running. */
export const alive = (h: Runtime, terminal: Terminal): Effect.Effect<boolean> =>
  h.process(terminal).pipe(
    Effect.map((p) => p.running),
    Effect.catchTag("RuntimeError", (error) => Effect.succeed(error.code !== "not_found")),
  )

/**
 * What a notice or result says instead of screen text (none is ever sent to an agent): the command that shows the
 * session's terminal on demand.
 */
export const peekHint = (id: string) => `to see its terminal, run: vibest peek ${id}`

/** The last lines on screen, trimmed; "" when the runtime cannot read them. For vibestd.log only. */
export const paneTail = (h: Runtime, terminal: Terminal | undefined, lines = 30) =>
  terminal
    ? h.read(terminal, lines).pipe(
        Effect.map((text) => text.trim()),
        Effect.orElseSucceed(() => ""),
      )
    : Effect.succeed("")

/** The `machines[]` of `agent.start.before` (§7): one `local` machine with every registered runtime's status and the harnesses vibestd can start there. */
export const machinesListing = (
  runtimes: RuntimesShape,
  harnesses: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<VibestPlugin.MachineInfo>> =>
  runtimes.statuses({ id: "local" }).pipe(
    Effect.map((rows) => [
      {
        machine: "local",
        runtimes: rows.map(({ runtime, status }) => ({
          kind: runtime.kind,
          status: status.status,
          ...("reason" in status ? { reason: status.reason } : {}),
        })),
        harnesses,
      },
    ]),
  )
