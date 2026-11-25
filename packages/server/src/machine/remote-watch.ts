import { withHeaders } from "@vibest/client/client"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Identity } from "@vibest/core/identity"
import { Host } from "@vibest/plugin/host"
import { remoteHeaders } from "@vibest/protocol/protocol"
import { type ProjectRow, type WatchEvent, type WatchSession } from "@vibest/protocol/schemas"
import type { ListedMachine } from "@vibest/schema/machine"
import { Cause, Context, Duration, Effect, FiberMap, Layer, Match, Stream } from "effect"

import * as Listing from "../listing.ts"
import { watchFanout } from "../watch-feed.ts"
import { Machines } from "./machines.ts"

export * as RemoteWatch from "./remote-watch.ts"

const WATCH_RETRY = Host.reconnectSchedule({ first: Machines.RETRY_FIRST, max: Duration.seconds(30) })

interface Mirror {
  machine: ListedMachine
  link: Machines.Link | undefined
  projects: Map<string, ProjectRow>
  sessions: Map<string, WatchSession>
}

const listedFor = (machine: ListedMachine, link: Machines.Link | undefined): ListedMachine =>
  machine.state === "connected" && link !== undefined && link.capabilities.remoteWatch !== true
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
  const fanout = watchFanout()
  const fibers = yield* FiberMap.make<string>()
  const mirrors = new Map<string, Mirror>()

  const clearCached = (name: string, mirror: Mirror) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const ended = Array.from(mirror.sessions.values())
        mirror.sessions = new Map()
        mirror.projects = new Map()

        for (const session of ended)
          yield* fanout.publish(
            Listing.WatchEvents.SessionEnded({ id: session.id, projectId: session.projectId, machine: name }),
          )
      }),
    )

  const applyRemoteEvent = (name: string, mirror: Mirror, event: WatchEvent) =>
    Match.value(event).pipe(
      Match.tagsExhaustive({
        Snapshot: ({ projects, sessions }) =>
          Effect.gen(function* () {
            const mappedSessions = yield* machines.viewSessions(name, sessions)

            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const nextProjects = new Map<string, ProjectRow>()
                const nextSessions = new Map<string, WatchSession>()

                for (const project of projects) nextProjects.set(project.id, { ...project, machine: name })

                for (const session of mappedSessions) nextSessions.set(session.id, session)

                const ended: Array<WatchSession> = []

                for (const [id, prev] of mirror.sessions) if (!nextSessions.has(id)) ended.push(prev)
                mirror.projects = nextProjects
                mirror.sessions = nextSessions

                for (const prev of ended)
                  yield* fanout.publish(
                    Listing.WatchEvents.SessionEnded({ id: prev.id, projectId: prev.projectId, machine: name }),
                  )

                for (const project of nextProjects.values())
                  yield* fanout.publish(Listing.WatchEvents.Project({ project }))

                for (const session of nextSessions.values())
                  yield* fanout.publish(Listing.WatchEvents.Session({ session }))
              }),
            )
          }),
        Project: ({ project }) => {
          const tagged: ProjectRow = { ...project, machine: name }
          mirror.projects.set(tagged.id, tagged)

          return fanout.publish(Listing.WatchEvents.Project({ project: tagged }))
        },
        Session: ({ session }) =>
          Effect.gen(function* () {
            const [mapped] = yield* machines.viewSessions(name, [session])
            const tagged: WatchSession = mapped!
            mirror.sessions.set(tagged.id, tagged)

            return yield* fanout.publish(Listing.WatchEvents.Session({ session: tagged }))
          }),
        SessionEnded: ({ id, projectId }) => {
          mirror.sessions.delete(id)

          return fanout.publish(Listing.WatchEvents.SessionEnded({ id, projectId, machine: name }))
        },
        Machine: () => Effect.void,
        MachineRemoved: () => Effect.void,
      }),
    )

  const watchRemote = (name: string, mirror: Mirror, link: Machines.Link) =>
    link
      .stream(Stream.unwrap(withHeaders(link.client["server.watch"]["watch.subscribe"](), remoteHeaders(self.id))))
      .pipe(
        Stream.runForEach((event) => applyRemoteEvent(name, mirror, event)),
        Effect.tap(() => Effect.logWarning("remote watch stream ended; reconnecting", { machine: name })),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : Effect.logWarning("remote watch stream failed; reconnecting", { machine: name, cause }),
        ),
        Effect.repeat({ schedule: WATCH_RETRY, while: () => mirror.link === link }),
        Effect.asVoid,
      )

  const syncMachine = (rawMachine: ListedMachine, link: Machines.Link | undefined) =>
    Effect.gen(function* () {
      const shown = listedFor(rawMachine, link)
      const existing = mirrors.get(shown.name)

      if (existing !== undefined && shown.since < existing.machine.since) return

      const mirror: Mirror = existing ?? {
        machine: shown,
        link: undefined,
        projects: new Map(),
        sessions: new Map(),
      }

      const sameConnected =
        shown.state === "connected" &&
        link !== undefined &&
        mirror.link === link &&
        mirror.machine.state === "connected"

      mirror.machine = shown
      mirrors.set(shown.name, mirror)

      if (shown.state === "connected" && link !== undefined) {
        if (!sameConnected) {
          mirror.link = link
          yield* FiberMap.run(fibers, shown.name, watchRemote(shown.name, mirror, link), { startImmediately: true })
        }

        yield* fanout.publish(Listing.WatchEvents.Machine({ machine: shown }))

        return
      }

      mirror.link = undefined
      yield* FiberMap.remove(fibers, shown.name)
      yield* fanout.publish(Listing.WatchEvents.Machine({ machine: shown }))

      if (shown.state !== "connecting") yield* clearCached(shown.name, mirror)
    })

  const removeMachine = (name: string) =>
    Effect.gen(function* () {
      yield* FiberMap.remove(fibers, name)
      const mirror = mirrors.get(name)

      if (mirror !== undefined) {
        yield* clearCached(name, mirror)
        mirrors.delete(name)
      }

      yield* fanout.publish(Listing.WatchEvents.MachineRemoved({ name }))
    })

  const watched = yield* machines.watchStates

  for (const { machine, link } of watched.initial) yield* syncMachine(machine, link)

  yield* watched.changes.pipe(
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
    subscribe: fanout.subscribe,
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
