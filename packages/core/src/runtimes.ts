import * as VibestPlugin from "@vibest/plugin"
import { NoRuntime } from "@vibest/schema/session"
import { Cause, Context, Effect, FileSystem, Layer, type Scope, Stream } from "effect"

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

export interface RuntimesShape {
  readonly register: (runtime: Runtime) => Effect.Effect<void, never, Scope.Scope>
  readonly all: Effect.Effect<ReadonlyArray<Runtime>>
  readonly route: (kind: string) => Effect.Effect<Runtime, NoRuntime>
  readonly statuses: (
    machine: Machine,
  ) => Effect.Effect<ReadonlyArray<{ readonly runtime: Runtime; readonly status: MachineStatus }>>
  readonly online: (runtime: Runtime, machine: Machine) => Effect.Effect<void, NoRuntime>
}

const live = (kind: string, event: RuntimeEvent): LiveEvent => {
  switch (event.type) {
    case "state":
      return { type: "live.state", runtime: kind, terminal: event.terminal, state: event.state }
    case "exited":
      return { type: "live.exited", runtime: kind, terminal: event.terminal }
    case "seen":
      return { type: "live.seen", runtime: kind, terminal: event.terminal }
    case "reset":
      return { type: "live.reset", runtime: kind, machine: event.machine }
  }
}

const make = (initial: ReadonlyArray<Runtime> = []): Effect.Effect<RuntimesShape, never, Bus | Scope.Scope> =>
  Effect.gen(function* () {
    const bus = yield* Bus
    let registered: ReadonlyArray<Runtime> = initial
    const merge = (runtime: Runtime, scope: Scope.Scope) =>
      runtime.events.pipe(
        Stream.runForEach((event) => bus.observe(live(runtime.kind, event))),
        Effect.catchCause(() => Effect.void),
        Effect.forkIn(scope),
      )
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
          yield* merge(runtime, yield* Effect.scope)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              registered = registered.filter((loaded) => loaded !== runtime)
            }),
          )
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

const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export class Runtimes extends Context.Service<Runtimes, RuntimesShape>()("vibest/Runtimes") {
  static readonly layer = Layer.effect(Runtimes, make())
}

export const registry = make

export const readFile = (machine: Machine, file: string): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    if (machine.id !== "local")
      return yield* Effect.fail(new Error(`reading ${file} on machine ${machine.id} is not supported yet`))
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(file)
  }).pipe(Effect.mapError((e) => new Error(`read ${file}: ${e.message}`)))

export type AgentSeen = AgentState | "absent"

export const stateOf = (seen: AgentSeen): AgentState | undefined => (seen === "absent" ? undefined : seen)

export const agentState = (h: Runtime, terminal: Terminal): Effect.Effect<AgentSeen, RuntimeError> =>
  h.state === undefined
    ? Effect.succeed("unknown")
    : h
        .state(terminal)
        .pipe(
          Effect.catchTag("RuntimeError", (error) =>
            error.code === "not_found"
              ? Effect.succeed("absent" as AgentSeen)
              : error.code === "unreachable"
                ? Effect.fail(error)
                : Effect.succeed("unknown" as AgentSeen),
          ),
        )

export const alive = (h: Runtime, terminal: Terminal): Effect.Effect<boolean> =>
  h.process(terminal).pipe(
    Effect.map((p) => p.running),
    Effect.catchTag("RuntimeError", (error) => Effect.succeed(error.code !== "not_found")),
  )

export const peekHint = (id: string) => `to see its terminal, run: vibest peek ${id}`

export const paneTail = (h: Runtime, terminal: Terminal | undefined, lines = 30) =>
  terminal
    ? h.read(terminal, lines).pipe(
        Effect.map((text) => text.trim()),
        Effect.orElseSucceed(() => ""),
      )
    : Effect.succeed("")

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
