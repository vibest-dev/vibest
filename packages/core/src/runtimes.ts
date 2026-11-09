import * as VibestPlugin from "@vibest/plugin"
import { NoRuntime } from "@vibest/schema/session"
import { Cause, Context, Effect, Fiber, FileSystem, Layer, PubSub, type Scope, Stream } from "effect"

import { Bus, type LiveEvent } from "./bus.ts"
import type { HostEnv as HostEnvShape, RuntimesShape } from "./host.ts"
import * as Registry from "./registry.ts"

export { NoRuntime }

export type Runtime = VibestPlugin.Runtime.RuntimeDefinition
export type Machine = VibestPlugin.Runtime.Machine
export type MachineStatus = VibestPlugin.Runtime.MachineStatus
export type Terminal = VibestPlugin.Runtime.Terminal
export type AgentState = VibestPlugin.Runtime.AgentState
export type RuntimeError = VibestPlugin.Runtime.RuntimeError
export const RuntimeError = VibestPlugin.Runtime.RuntimeError
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent

export type { RuntimesShape }

const live = (runtime: string, event: RuntimeEvent): LiveEvent => {
  switch (event.type) {
    case "state":
      return { type: "live.state", runtime, terminal: event.terminal, state: event.state }
    case "exited":
      return { type: "live.exited", runtime, terminal: event.terminal }
    case "seen":
      return { type: "live.seen", runtime, terminal: event.terminal }
    case "reset":
      return { type: "live.reset", runtime, machine: event.machine }
  }
}

export const HostEnv = Context.Reference<HostEnvShape>("vibest/HostEnv", { defaultValue: () => ({ drop: () => {} }) })

const notLoaded = (id: string, loaded: ReadonlyArray<Runtime>) =>
  new NoRuntime({
    message: `the runtime "${id}" is not loaded${loaded.length === 0 ? "" : `; loaded: ${loaded.map((runtime) => runtime.id).join(", ")}`}`,
  })

const sameMembers = (a: Runtime, b: Runtime) => {
  const keys = Object.keys(a) as Array<keyof Runtime>
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export const make: Effect.Effect<RuntimesShape, never, Bus | Scope.Scope> = Effect.gen(function* () {
  const bus = yield* Bus
  const env = yield* HostEnv
  const own = yield* Effect.scope
  const merging = new Map<string, { readonly runtime: Runtime; readonly fiber: Fiber.Fiber<void> }>()
  const added = yield* PubSub.unbounded<ReadonlyArray<string>>()
  const reconcile = (list: ReadonlyArray<Runtime>) =>
    Effect.gen(function* () {
      for (const [id, entry] of merging) {
        const next = list.find((runtime) => runtime.id === id)
        if (next !== undefined && sameMembers(next, entry.runtime)) continue
        merging.delete(id)
        yield* Fiber.interrupt(entry.fiber)
      }
      const fresh: Array<string> = []
      for (const runtime of list) {
        const kept = merging.get(runtime.id)
        if (kept !== undefined) {
          merging.set(runtime.id, { runtime, fiber: kept.fiber })
          continue
        }
        fresh.push(runtime.id)
        const fiber = yield* runtime.events.pipe(
          Stream.runForEach((event) => bus.observe(live(runtime.id, event))),
          Effect.catchCause(() => Effect.void),
          Effect.forkIn(own),
        )
        merging.set(runtime.id, { runtime, fiber })
        yield* bus.observe({ type: "live.reset", runtime: runtime.id, machine: "local" })
      }
      env.drop(list.flatMap((runtime) => runtime.caller?.env ?? []))
      if (fresh.length > 0) yield* PubSub.publish(added, fresh)
    })
  const registry = Registry.definitions<Runtime>("runtime", reconcile)
  const all = Effect.sync(() => registry.get())
  return {
    transform: registry.transform,
    reload: registry.reload,
    all,
    route: (id) =>
      Effect.suspend(() => {
        const loaded = registry.get()
        const found = loaded.find((runtime) => runtime.id === id)
        return found === undefined ? Effect.fail(notLoaded(id, loaded)) : Effect.succeed(found)
      }),
    statuses: (machine) =>
      Effect.forEach(
        registry.get(),
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
                  message: `the runtime ${runtime.id} is ${status.status} on ${machine.id}${"reason" in status ? ` (${status.reason})` : ""}`,
                }),
              ),
        ),
        Effect.catchCause((cause) =>
          Effect.fail(
            new NoRuntime({
              message: `the runtime ${runtime.id}'s status on ${machine.id} could not be read: ${messageOf(cause)}`,
            }),
          ),
        ),
      ),
    added: Stream.fromPubSub(added),
    callers: Effect.sync(() =>
      registry
        .get()
        .flatMap((runtime) => (runtime.caller === undefined ? [] : [{ ...runtime.caller, id: runtime.id }])),
    ),
  }
})

const messageOf = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause)
  return error instanceof Error ? error.message : String(error)
}

export class Runtimes extends Context.Service<Runtimes, RuntimesShape>()("vibest/Runtimes") {
  static readonly layer = Layer.effect(Runtimes, make)
}

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

export const runtimesHere = (runtimes: RuntimesShape) =>
  Effect.flatMap(runtimes.statuses({ id: "local" }), (rows) =>
    Effect.forEach(
      rows,
      ({ runtime, status }) =>
        (runtime.link?.() ?? Effect.succeed(undefined)).pipe(
          Effect.catchCause(() => Effect.succeed(undefined)),
          Effect.map((link) => ({
            kind: runtime.id,
            status: status.status,
            ...("reason" in status ? { reason: status.reason } : {}),
            ...(link === undefined ? {} : { link }),
          })),
        ),
      { concurrency: "unbounded" },
    ),
  )

export const machinesListing = (
  runtimes: RuntimesShape,
  harnesses: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<VibestPlugin.MachineInfo>> =>
  runtimes.statuses({ id: "local" }).pipe(
    Effect.map((rows) => [
      {
        machine: "local",
        runtimes: rows.map(({ runtime, status }) => ({
          kind: runtime.id,
          status: status.status,
          ...("reason" in status ? { reason: status.reason } : {}),
        })),
        harnesses,
      },
    ]),
  )
