import type { AgentStatus } from "@vibest/schema/session"
import { Context, Effect, HashMap, Layer, Option, Ref, SynchronizedRef } from "effect"

import type { Integration } from "../db-rows.ts"
import { LayerNode } from "../effect/layer-node.ts"

export interface Tracked {
  readonly endedAt: Ref.Ref<number | undefined>
  readonly blockedNotified: Ref.Ref<boolean>
  readonly prompting: Ref.Ref<boolean>
  readonly stopping: Ref.Ref<boolean>
  readonly archiveTold: Ref.Ref<boolean>
  readonly launchRechecked: Ref.Ref<boolean>
  readonly forgetOnRelease: Ref.Ref<boolean>
}

const newTracked: Effect.Effect<Tracked> = Effect.all({
  endedAt: Ref.make<number | undefined>(undefined),
  blockedNotified: Ref.make(false),
  prompting: Ref.make(false),
  stopping: Ref.make(false),
  archiveTold: Ref.make(false),
  launchRechecked: Ref.make(false),
  forgetOnRelease: Ref.make(false),
})

const make = Effect.gen(function* () {
  const tracked = yield* SynchronizedRef.make(HashMap.empty<string, Tracked>())
  const statuses = new Map<string, AgentStatus>()
  const integrations = new Map<string, Integration>()
  const archiveOnIdle = new Set<string>()
  const restarting = new Set<string>()

  const track = Effect.fn("SessionLive.track")((id: string) =>
    SynchronizedRef.modifyEffect(tracked, (map) =>
      Option.match(HashMap.get(map, id), {
        onSome: (r) => Effect.succeed([r, map] as const),
        onNone: () => newTracked.pipe(Effect.map((r) => [r, HashMap.set(map, id, r)] as const)),
      }),
    ),
  )

  const stop = Effect.fn("SessionLive.stop")((id: string) =>
    SynchronizedRef.modifyEffect(tracked, (map) =>
      Effect.gen(function* () {
        const r = Option.getOrUndefined(HashMap.get(map, id)) ?? (yield* newTracked)
        const already = yield* Ref.getAndSet(r.stopping, true)
        return [{ r, already }, HashMap.set(map, id, r)] as const
      }),
    ),
  )

  const forget = Effect.fn("SessionLive.forget")((id: string) =>
    SynchronizedRef.updateEffect(tracked, (map) =>
      Effect.gen(function* () {
        const r = Option.getOrUndefined(HashMap.get(map, id))
        if (r === undefined) return map
        if ((yield* Ref.get(r.stopping)) || (yield* Ref.get(r.prompting))) {
          yield* Ref.set(r.forgetOnRelease, true)
          return map
        }
        return HashMap.remove(map, id)
      }),
    ),
  )

  const release = Effect.fn("SessionLive.release")((id: string, ended: boolean) =>
    SynchronizedRef.updateEffect(tracked, (map) =>
      Effect.gen(function* () {
        const r = Option.getOrUndefined(HashMap.get(map, id))
        if (r === undefined) return map
        yield* Ref.set(r.stopping, false)
        const done = ended || (yield* Ref.get(r.forgetOnRelease))
        return done && !(yield* Ref.get(r.prompting)) ? HashMap.remove(map, id) : map
      }),
    ),
  )

  const setStatus = Effect.fn("SessionLive.setStatus")((id: string, status: AgentStatus) =>
    Effect.sync(() => {
      if (status === "unknown") statuses.delete(id)
      else statuses.set(id, status)
    }),
  )

  const setIntegration = Effect.fn("SessionLive.setIntegration")((id: string, integration: Integration) =>
    Effect.sync(() => {
      integrations.set(id, integration)
    }),
  )

  const dropIntegration = Effect.fn("SessionLive.dropIntegration")((id: string) =>
    Effect.sync(() => {
      integrations.delete(id)
    }),
  )

  const archiveWhenIdle = Effect.fn("SessionLive.archiveWhenIdle")((id: string) =>
    Effect.sync(() => {
      archiveOnIdle.add(id)
    }),
  )

  const ended = Effect.fn("SessionLive.ended")((id: string) =>
    Effect.sync(() => {
      integrations.delete(id)
      archiveOnIdle.delete(id)
      statuses.delete(id)
    }),
  )

  const status = Effect.fn("SessionLive.status")((id: string): Effect.Effect<AgentStatus> =>
    Effect.sync(() => statuses.get(id) ?? "unknown"),
  )

  const integration = Effect.fn("SessionLive.integration")((id: string) => Effect.sync(() => integrations.get(id)))

  const archivesOnIdle = Effect.fn("SessionLive.archivesOnIdle")((id: string) =>
    Effect.sync(() => archiveOnIdle.has(id)),
  )

  const isRestarting = Effect.fn("SessionLive.restarting.has")((id: string) => Effect.sync(() => restarting.has(id)))

  const markRestarting = Effect.fn("SessionLive.restarting.mark")((id: string) =>
    Effect.sync(() => {
      restarting.add(id)
    }),
  )

  const clearRestarting = Effect.fn("SessionLive.restarting.clear")((id: string) =>
    Effect.sync(() => {
      restarting.delete(id)
    }),
  )

  const size = Effect.gen(function* () {
    return { tracked: HashMap.size(yield* SynchronizedRef.get(tracked)), statuses: statuses.size }
  })

  return {
    track,
    stop,
    forget,
    release,
    status,
    setStatus,
    integration,
    setIntegration,
    dropIntegration,
    archivesOnIdle,
    archiveWhenIdle,
    ended,
    size,
    restarting: { has: isRestarting, mark: markRestarting, clear: clearRestarting },
  }
})

export class SessionLive extends Context.Service<SessionLive, Effect.Success<typeof make>>()("vibest/SessionLive") {
  static readonly make = make

  static readonly layer = Layer.effect(SessionLive, make)

  static readonly node = LayerNode.make({ service: SessionLive, layer: SessionLive.layer, deps: [] })
}
