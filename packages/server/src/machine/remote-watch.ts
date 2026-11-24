import { LayerNode } from "@vibest/core/effect/layer-node"
import { Identity } from "@vibest/core/identity"
import { peerHeaders } from "@vibest/protocol/protocol"
import type { ProjectRow, WatchEvent, WatchSession } from "@vibest/protocol/rpc"
import type { ListedMachine } from "@vibest/schema/machine"
import { Cause, Context, Effect, Fiber, Layer, Match, PubSub, Stream } from "effect"

import * as Listing from "../listing.ts"
import { Machines } from "./machines.ts"

export * as RemoteWatch from "./remote-watch.ts"

interface Mirror {
  machine: ListedMachine
  readonly projects: Map<string, ProjectRow>
  readonly sessions: Map<string, WatchSession>
  fiber: Fiber.Fiber<void> | undefined
}

const listedFor = (machine: ListedMachine, link: Machines.Link | undefined): ListedMachine =>
  machine.state === "connected" && link !== undefined && link.capabilities.peerWatch !== true
    ? {
        name: machine.name,
        state: "incompatible",
        since: machine.since,
        reason: `${machine.name} runs an older vibest that does not stream Watch; run vibest update on ${machine.name}`,
      }
    : machine

const make = Effect.gen(function* () {
  const machines = yield* Machines.Service
  const self = yield* Identity.Service
  const scope = yield* Effect.scope
  const events = yield* PubSub.unbounded<WatchEvent>()
  const mirrors = new Map<string, Mirror>()

  const publish = (event: WatchEvent) => PubSub.publish(events, event)

  const stopMirrorFiber = (mirror: Mirror) =>
    Effect.gen(function* () {
      const current = mirror.fiber

      if (current === undefined) return
      mirror.fiber = undefined
      yield* Fiber.interrupt(current)
    })

  const clearCached = (name: string, mirror: Mirror) =>
    Effect.gen(function* () {
      const ended = Array.from(mirror.sessions.values())
      mirror.sessions.clear()
      mirror.projects.clear()

      for (const session of ended)
        yield* publish(
          Listing.WatchEvents.SessionEnded({ id: session.id, projectId: session.projectId, machine: name }),
        )
    })

  const applyRemoteEvent = (name: string, mirror: Mirror, event: WatchEvent) =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        Snapshot: ({ projects, sessions }) =>
          Effect.gen(function* () {
            const nextProjects = new Map<string, ProjectRow>()
            const nextSessions = new Map<string, WatchSession>()

            for (const project of projects) nextProjects.set(project.id, { ...project, machine: name })

            for (const session of sessions) nextSessions.set(session.id, { ...session, machine: name })

            for (const [id, prev] of mirror.sessions)
              if (!nextSessions.has(id))
                yield* publish(Listing.WatchEvents.SessionEnded({ id, projectId: prev.projectId, machine: name }))
            mirror.projects.clear()
            mirror.sessions.clear()

            for (const [id, project] of nextProjects) mirror.projects.set(id, project)

            for (const [id, session] of nextSessions) mirror.sessions.set(id, session)

            for (const project of nextProjects.values()) yield* publish(Listing.WatchEvents.Project({ project }))

            for (const session of nextSessions.values()) yield* publish(Listing.WatchEvents.Session({ session }))
          }),
        Project: ({ project }) => {
          const tagged: ProjectRow = { ...project, machine: name }
          mirror.projects.set(tagged.id, tagged)

          return publish(Listing.WatchEvents.Project({ project: tagged }))
        },
        Session: ({ session }) => {
          const tagged: WatchSession = { ...session, machine: name }
          mirror.sessions.set(tagged.id, tagged)

          return publish(Listing.WatchEvents.Session({ session: tagged }))
        },
        SessionEnded: ({ id, projectId }) => {
          mirror.sessions.delete(id)

          return publish(Listing.WatchEvents.SessionEnded({ id, projectId, machine: name }))
        },
        Machine: () => Effect.void,
        MachineRemoved: () => Effect.void,
      }),
    )

  const syncMachine = (rawMachine: ListedMachine, link: Machines.Link | undefined) =>
    Effect.gen(function* () {
      const shown = listedFor(rawMachine, link)

      const mirror: Mirror = mirrors.get(shown.name) ?? {
        machine: shown,
        projects: new Map(),
        sessions: new Map(),
        fiber: undefined,
      }

      mirror.machine = shown
      mirrors.set(shown.name, mirror)
      yield* publish(Listing.WatchEvents.Machine({ machine: shown }))

      if (shown.state === "connected" && link !== undefined) {
        yield* stopMirrorFiber(mirror)

        mirror.fiber = yield* link.stream(link.client.Watch(undefined, { headers: peerHeaders(self.id) })).pipe(
          Stream.runForEach((event) => applyRemoteEvent(shown.name, mirror, event)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : Effect.logWarning(`remote watch ${shown.name} ended`, cause),
          ),
          Effect.forkIn(scope, { startImmediately: true }),
        )

        return
      }

      yield* stopMirrorFiber(mirror)

      if (shown.state !== "connecting") yield* clearCached(shown.name, mirror)
    })

  const removeMachine = (name: string) =>
    Effect.gen(function* () {
      const mirror = mirrors.get(name)

      if (mirror !== undefined) {
        yield* stopMirrorFiber(mirror)
        yield* clearCached(name, mirror)
        mirrors.delete(name)
      }

      yield* publish(Listing.WatchEvents.MachineRemoved({ name }))
    })

  const changeSubscription = yield* machines.subscribeChanges

  for (const { info, link } of yield* machines.states)
    yield* syncMachine(
      {
        name: info.name,
        state: info.state,
        since: info.since,
        ...(info.reason !== undefined && info.state !== "connected" && { reason: info.reason }),
      },
      link,
    )

  yield* Stream.fromSubscription(changeSubscription).pipe(
    Stream.runForEach((change) =>
      Match.value(change).pipe(
        Match.tagsExhaustive({
          Updated: ({ machine, link }) => syncMachine(machine, link),
          Removed: ({ name }) => removeMachine(name),
        }),
      ),
    ),
    Effect.forkIn(scope, { startImmediately: true }),
  )

  return {
    snapshot: Effect.sync(() => {
      const projects: Array<ProjectRow> = []
      const sessions: Array<WatchSession> = []
      const listedMachines: Array<ListedMachine> = []

      for (const mirror of mirrors.values()) {
        listedMachines.push(mirror.machine)
        projects.push(...mirror.projects.values())
        sessions.push(...mirror.sessions.values())
      }

      return { projects, sessions, machines: listedMachines }
    }),
    subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/RemoteWatch") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Machines.node, Identity.node],
})
