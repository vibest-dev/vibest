import { App } from "@vibest/core/app"
import { Db } from "@vibest/core/database/db"
import type { RemoteScope } from "@vibest/core/database/remote"
import { Identity } from "@vibest/core/identity"
import { Runtimes, runtimesHere } from "@vibest/core/runtimes"
import { REMOTE_BY_USER, REMOTE_PROJECT_HEADER } from "@vibest/protocol/protocol"
import { Caller, type CallerIdentity, Forbidden, type PayloadOf } from "@vibest/protocol/rpc"
import { MachineIncompatible } from "@vibest/schema/machine"
import { AmbiguousSession, type NotInRepository } from "@vibest/schema/session"
import { formatSessionRef, type SessionRef } from "@vibest/schema/terminal"
import { Context, Effect, Layer, Predicate, Stream } from "effect"

import * as Listing from "../listing.ts"
import { Inbound } from "../machine/inbound.ts"
import { Load } from "../machine/load.ts"
import { Machines } from "../machine/machines.ts"
import { type At, ListScope, Remote } from "../machine/remote.ts"
import * as CallerChecks from "./caller.ts"
import type { Handlers } from "./caller.ts"
import { group } from "./group.ts"

type Routed = "Send" | "Interrupt" | "Stop" | "Archive" | "Get" | "Peek"

type Local<A, E, R> = (id: string) => Effect.Effect<A, E, R>

const notRemote = (method: string) => new Forbidden({ method, message: `${method} is for another vibestd` })

const byOf = (c: CallerIdentity) => (Predicate.isTagged(c, "Session") ? c.sessionId : REMOTE_BY_USER)

const remoteOf = (method: string) =>
  Effect.flatMap(Caller, (c) =>
    Predicate.isTagged(c, "Remote") ? Effect.succeed(c.remoteId) : Effect.fail(notRemote(method)),
  )

const remoteScope = (method: string) =>
  Effect.flatMap(Caller, (c): Effect.Effect<RemoteScope | undefined, Forbidden> => {
    if (!Predicate.isTagged(c, "Remote")) return Effect.succeed(undefined)

    if (c.projectId === undefined)
      return Effect.fail(
        new Forbidden({ method, message: `${method} needs the calling project (${REMOTE_PROJECT_HEADER})` }),
      )

    return Effect.succeed({
      remote: c.remoteId,
      project: c.projectId,
      ...(c.session !== undefined && { session: c.session }),
    })
  })

const makeRouting = Effect.gen(function* () {
  const deps = yield* CallerChecks.Service
  const remote = yield* Remote.Service
  const machines = yield* Machines.Service
  const db = yield* Db.Service

  const senderHere = (by: string) => (by === REMOTE_BY_USER ? Effect.succeed(undefined) : db.remote.senderOf(by))

  const reach = (method: Routed | "List") =>
    Effect.gen(function* () {
      const scope = yield* remoteScope(method)

      if (scope !== undefined) return { c: undefined, scope }

      return { c: yield* deps.agent(method), scope }
    })

  const refused = (method: string) => (e: NotInRepository) =>
    Effect.fail(new Forbidden({ method, message: `${method} on another machine: ${e.message}` }))

  const routed = <A, E, R2, B, F>(
    method: Routed,
    ref: SessionRef,
    local: Local<A, E, R2>,
    forwarded: (at: At, project: string, by: string) => Effect.Effect<B, F>,
  ) =>
    ref.machine === undefined
      ? local(ref.id)
      : deps.agent(method).pipe(
          Effect.flatMap((c) =>
            deps.projectOf(c, method).pipe(
              Effect.catchTag("NotInRepository", refused(method)),
              Effect.flatMap((project) => forwarded({ machine: ref.machine!, id: ref.id }, project.id, byOf(c))),
            ),
          ),
        )

  return {
    reach,
    routed: {
      Send: <A, E, R2>(p: PayloadOf<"Send">, local: Local<A, E, R2>) =>
        routed("Send", p, local, (at, project, by) =>
          Effect.gen(function* () {
            let targetAt = at
            let forwardBy = by

            if (by !== REMOTE_BY_USER) {
              const machineRow = yield* db.remote.machineNamed(at.machine)

              if (machineRow !== undefined) {
                const matches = yield* db.session.resolveRemoteEdges(by, at.id, machineRow.remoteId)

                if (matches.length === 0)
                  return yield* new Forbidden({
                    method: "Send",
                    message: `${formatSessionRef(p)} is not linked from this session; link them with vibest session link`,
                  })

                if (matches.length > 1)
                  return yield* new AmbiguousSession({
                    prefix: at.id,
                    matches: matches.map((m) => `${at.machine}/${m.session}`),
                  })

                targetAt = { ...at, id: matches[0]!.session }
                forwardBy = REMOTE_BY_USER
              }
            }

            const from = yield* senderHere(by)

            return yield* remote.forward(targetAt, project, forwardBy, (c, { id }, o) =>
              c.Send(
                {
                  id,
                  message: p.message,
                  ...(p.request !== undefined && { request: p.request }),
                  ...(from !== undefined && { from }),
                },
                o,
              ),
            )
          }),
        ),
      Interrupt: <A, E, R2>(p: PayloadOf<"Interrupt">, local: Local<A, E, R2>) =>
        routed("Interrupt", p, local, (at, project, by) =>
          remote.forward(at, project, by, (c, { id }, o) => c.Interrupt({ id }, o)),
        ),
      Stop: <A, E, R2>(p: PayloadOf<"Stop">, local: Local<A, E, R2>) =>
        routed("Stop", p, local, (at, project, by) =>
          machines.link(at.machine).pipe(
            Effect.flatMap((link) =>
              link.capabilities.stop === true
                ? remote.forward(at, project, by, (c, { id }, o) => c.Stop({ id }, o))
                : Effect.fail(
                    new MachineIncompatible({
                      machine: at.machine,
                      message: `${at.machine} runs a vibest that has no vibest stop; run vibest update there`,
                    }),
                  ),
            ),
          ),
        ),
      Archive: <A, E, R2>(p: PayloadOf<"Archive">, local: Local<A, E, R2>) =>
        routed("Archive", p, local, (at, project, by) =>
          remote.forward(at, project, by, (c, { id }, o) =>
            c.Archive({ id, ...(p.keepWorktree !== undefined && { keepWorktree: p.keepWorktree }) }, o),
          ),
        ),
      Get: <A, E, R2>(p: PayloadOf<"Get">, local: Local<A, E, R2>) =>
        routed("Get", p, local, (at, project, by) => remote.get(at, project, by, p)),
      Peek: <A, E, R2>(p: PayloadOf<"Peek">, local: Local<A, E, R2>) =>
        routed("Peek", p, local, (at, project, by) => remote.peek(at, project, by, p)),
    },

    spawnOn: (machine: string, input: PayloadOf<"Spawn">, session: string, project: string) =>
      remote.spawn(machine, input, { project, session }),
  }
})

export type RoutingInterface = Effect.Success<typeof makeRouting>

export class Routing extends Context.Service<Routing, RoutingInterface>()("vibest/Routing") {}

export const routingLayer = Layer.effect(Routing, makeRouting)

const make = Effect.gen(function* () {
  const checks = yield* CallerChecks.Service
  const listing = yield* Listing.Service
  const { reach } = yield* Routing
  const db = yield* Db.Service
  const self = yield* Identity.Service
  const { version } = yield* App.Service
  const machines = yield* Machines.Service
  const load = yield* Load.Service
  const inbound = yield* Inbound.Service
  const remote = yield* Remote.Service
  const runtimes = yield* Runtimes.Service
  const { cliOnly, findAt } = checks

  const listScope = (all: boolean | undefined) =>
    Effect.gen(function* () {
      const { c, scope } = yield* reach("List")

      if (c === undefined) return ListScope.Remote(scope)

      if (Predicate.isTagged(c, "Session")) return ListScope.Project({ id: c.projectId })

      if (all === true) return ListScope.All()

      return yield* findAt(c.repositoryRoot).pipe(
        Effect.map((row): ListScope => (row === undefined ? ListScope.Nothing() : ListScope.Project({ id: row.id }))),
        Effect.catchTag("NotInRepository", () => Effect.succeed(ListScope.All())),
      )
    })

  return {
    List: ({ stopped, all }: PayloadOf<"List">) =>
      Effect.gen(function* () {
        const scope = yield* listScope(all)
        const local = yield* listing.listed(scope, stopped === true)
        const away = yield* remote.list(scope, byOf(yield* Caller), stopped)

        return { sessions: [...local, ...away.sessions], machines: away.machines }
      }),

    "Remote.Hello": ({ id, name }: PayloadOf<"Remote.Hello">) =>
      Effect.gen(function* () {
        if ((yield* remoteOf("Remote.Hello")) !== id)
          return yield* new Forbidden({
            method: "Remote.Hello",
            message: "Remote.Hello names the vibestd that calls it",
          })

        if (id !== self.id) yield* db.remote.noteRemote({ id, name })

        return { id: self.id, name: self.name, version, runtimes: yield* runtimesHere(runtimes) }
      }),

    "Remote.Spawn": (input: PayloadOf<"Remote.Spawn">) =>
      Effect.gen(function* () {
        const scope = yield* remoteScope("Remote.Spawn")

        if (scope === undefined) return yield* notRemote("Remote.Spawn")

        if (scope.session === undefined)
          return yield* new Forbidden({
            method: "Remote.Spawn",
            message: "Remote.Spawn is started by a session; it is not run in the user's name",
          })

        return yield* inbound.spawn(scope.remote, scope.project, scope.session, input)
      }),

    "Project.Clone": ({ url, directory, machine }: PayloadOf<"Project.Clone">) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const away = machine !== undefined

          if (away && Predicate.isTagged(yield* Caller, "Remote"))
            return yield* new Forbidden({ method: "Project.Clone", message: "a remote clones only on this machine" })

          return remote.clone(away ? machine : undefined, { url, directory })
        }),
      ),

    "Remote.Outbox": () => Stream.unwrap(Effect.map(remoteOf("Remote.Outbox"), (id) => inbound.outbox(id))),

    "Remote.Ack": ({ ids }: PayloadOf<"Remote.Ack">) =>
      Effect.flatMap(remoteOf("Remote.Ack"), (id) => inbound.ack(id, ids)),

    "Remote.Link": ({ edges }: PayloadOf<"Remote.Link">) =>
      remoteOf("Remote.Link").pipe(Effect.andThen(inbound.link(edges))),

    "Remote.Unlink": ({ edges }: PayloadOf<"Remote.Unlink">) =>
      remoteOf("Remote.Unlink").pipe(Effect.andThen(inbound.unlink(edges))),

    "Machine.Add": ({ name, target }: PayloadOf<"Machine.Add">) =>
      cliOnly("Machine.Add").pipe(Effect.andThen(machines.add(name, target))),

    "Machine.Load": ({ machine }: PayloadOf<"Machine.Load">) =>
      Effect.gen(function* () {
        const caller = yield* Caller

        if (Predicate.isTagged(caller, "Remote")) {
          if (machine !== undefined)
            return yield* new Forbidden({ method: "Machine.Load", message: "a remote reads its own machine" })

          return yield* load.read()
        }

        if (!Predicate.isTagged(caller, "Cli"))
          return yield* new Forbidden({
            method: "Machine.Load",
            message: "only the user or another machine reads the load",
          })

        if (machine === undefined) return yield* load.read()

        return yield* machines.reading(machine)
      }),

    "Machine.List": () => cliOnly("Machine.List").pipe(Effect.andThen(machines.listing)),

    "Machine.Remove": ({ name }: PayloadOf<"Machine.Remove">) =>
      cliOnly("Machine.Remove").pipe(Effect.andThen(machines.remove(name))),
  } satisfies Handlers
})

export const layer = group([
  "List",
  "Remote.Hello",
  "Remote.Spawn",
  "Project.Clone",
  "Remote.Outbox",
  "Remote.Ack",
  "Remote.Link",
  "Remote.Unlink",
  "Machine.Add",
  "Machine.Load",
  "Machine.List",
  "Machine.Remove",
]).toLayer(make)
