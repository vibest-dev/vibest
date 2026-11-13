import * as VibestPlugin from "@vibest/plugin"
import { messageOf } from "@vibest/schema/error"
import { NoRuntime, type RuntimeAddress } from "@vibest/schema/session"
import { Cause, Context, Effect, Fiber, Layer, PubSub, type Scope, Stream } from "effect"

import { Bus, type Signal } from "./bus.ts"
import { LayerNode } from "./effect/layer-node.ts"
import type { HostEnv as HostEnvShape, RuntimesShape } from "./host.ts"
import * as Registry from "./registry.ts"

export { NoRuntime }

export type Runtime = VibestPlugin.Runtime.RuntimeDefinition
export type RuntimeStatus = VibestPlugin.Runtime.RuntimeStatus
export type Terminal = RuntimeAddress
export type AgentState = VibestPlugin.Runtime.AgentState
export type RuntimeError = VibestPlugin.Runtime.RuntimeError
export const RuntimeError = VibestPlugin.Runtime.RuntimeError
export type RuntimeEvent = VibestPlugin.Runtime.RuntimeEvent

export type { RuntimesShape }

export const addressOf = (terminal: VibestPlugin.Runtime.Terminal): Terminal => ({ machine: "local", id: terminal.id })

const live = (runtime: string, event: RuntimeEvent): Signal => {
  switch (event.type) {
    case "state":
      return { type: "terminal.state", runtime, terminal: addressOf(event.terminal), state: event.state }
    case "exited":
      return { type: "terminal.exited", runtime, terminal: addressOf(event.terminal) }
    case "seen":
      return { type: "terminal.seen", runtime, terminal: addressOf(event.terminal) }
    case "reset":
      return { type: "runtime.reset", runtime, machine: "local" }
  }
}

export class HostEnv extends Context.Service<HostEnv, HostEnvShape>()("vibest/HostEnv") {
  static readonly node = LayerNode.unbound(HostEnv)
}

const notLoaded = (id: string, loaded: ReadonlyArray<Runtime>) =>
  new NoRuntime({
    message: `the runtime "${id}" is not loaded${loaded.length === 0 ? "" : `; loaded: ${loaded.map((runtime) => runtime.id).join(", ")}`}`,
  })

const sameMembers = (a: Runtime, b: Runtime) => {
  const keys = Object.keys(a) as Array<keyof Runtime>
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

export const make: Effect.Effect<RuntimesShape, never, Bus | HostEnv | Scope.Scope> = Effect.gen(function* () {
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
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError(`runtime ${runtime.id} events ended: ${Cause.pretty(cause)}`).pipe(
                  Effect.andThen(bus.observe({ type: "runtime.reset", runtime: runtime.id, machine: "local" })),
                ),
          ),
          Effect.forkIn(own),
        )
        merging.set(runtime.id, { runtime, fiber })
        yield* bus.observe({ type: "runtime.reset", runtime: runtime.id, machine: "local" })
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
    find: (id) => (id ? registry.get().find((runtime) => runtime.id === id) : undefined),
    route: (id) =>
      Effect.suspend(() => {
        const loaded = registry.get()
        const found = loaded.find((runtime) => runtime.id === id)
        return found === undefined ? Effect.fail(notLoaded(id, loaded)) : Effect.succeed(found)
      }),
    statuses: Effect.suspend(() =>
      Effect.forEach(
        registry.get(),
        (runtime) => runtime.status().pipe(Effect.map((status) => ({ runtime, status }))),
        { concurrency: "unbounded" },
      ),
    ),
    online: (runtime) =>
      runtime.status().pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.fail(
                new NoRuntime({
                  message: `the runtime ${runtime.id}'s status could not be read: ${messageOf(Cause.squash(cause))}`,
                }),
              ),
        ),
        Effect.flatMap((status) =>
          status.status === "online"
            ? Effect.void
            : Effect.fail(
                new NoRuntime({
                  message: `the runtime ${runtime.id} is ${status.status}${"reason" in status ? ` (${status.reason})` : ""}`,
                }),
              ),
        ),
      ),
    added: Stream.fromPubSub(added),
    callers: Effect.sync(() =>
      registry.get().flatMap((runtime) =>
        runtime.caller === undefined
          ? []
          : [
              {
                ...runtime.caller,
                id: runtime.id,
                ...(runtime.name === undefined ? {} : { name: runtime.name }),
              },
            ],
      ),
    ),
  }
})

export class Runtimes extends Context.Service<Runtimes, RuntimesShape>()("vibest/Runtimes") {
  static readonly layer = Layer.effect(Runtimes, make)

  static readonly node = LayerNode.make({ service: Runtimes, layer: Runtimes.layer, deps: [Bus.node, HostEnv.node] })
}

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
  Effect.flatMap(runtimes.statuses, (rows) =>
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
  runtimes.statuses.pipe(
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
