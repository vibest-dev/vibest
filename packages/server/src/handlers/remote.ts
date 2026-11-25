import { App } from "@vibest/core/app"
import { Db } from "@vibest/core/database/db"
import type { RemoteScope } from "@vibest/core/database/remote"
import { Identity } from "@vibest/core/identity"
import { Runtimes, runtimesHere } from "@vibest/core/runtimes"
import { VibestApi } from "@vibest/protocol/api"
import { Forbidden } from "@vibest/protocol/errors"
import { Caller, type CallerIdentity } from "@vibest/protocol/middleware"
import type { SendBody, SpawnPayload } from "@vibest/protocol/payloads"
import { REMOTE_BY_USER, REMOTE_PROJECT_HEADER } from "@vibest/protocol/protocol"
import { MachineIncompatible } from "@vibest/schema/machine"
import { AmbiguousSession, type NotInRepository } from "@vibest/schema/session"
import type { SessionRef } from "@vibest/schema/terminal"
import { Context, Effect, Layer, Predicate } from "effect"
import { HttpApiBuilder } from "effect/http-api"

import { Inbound } from "../machine/inbound.ts"
import { Machines } from "../machine/machines.ts"
import { type At, Remote } from "../machine/remote.ts"
import * as CallerChecks from "./caller.ts"

type Routed = "session.send" | "session.interrupt" | "session.stop" | "session.archive" | "session.get" | "session.peek"

type Local<A, E, R> = (id: string) => Effect.Effect<A, E, R>

const notRemote = (method: string) => new Forbidden({ method, message: `${method} is for another vibestd` })

export const byOf = (c: CallerIdentity) => (Predicate.isTagged(c, "Session") ? c.sessionId : REMOTE_BY_USER)

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

  const reach = (method: Routed | "session.list") =>
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

  const forwardSend = (
    p: SendBody & { readonly id: string },
    targetAt: At,
    project: string,
    forwardBy: string,
    senderBy: string,
  ) =>
    Effect.gen(function* () {
      const from = yield* senderHere(senderBy)

      return yield* remote.forward(targetAt, project, forwardBy, (c, { id }) =>
        c["server.session"]["session.send"]({
          params: { id },
          payload: {
            message: p.message,
            ...(p.request !== undefined && { request: p.request }),
            ...(from !== undefined && { from }),
          },
        }),
      )
    })

  return {
    reach,
    routed: {
      send: <A, E, R2>(p: SendBody & { readonly id: string }, local: Local<A, E, R2>) =>
        p.machine === undefined
          ? Effect.flatMap(Caller, (caller) => {
              if (!Predicate.isTagged(caller, "Session")) return local(p.id)

              return Effect.gen(function* () {
                const remoteMatches = yield* db.session.resolveRemoteEdges(caller.sessionId, p.id)

                if (remoteMatches.length === 0) return yield* local(p.id)

                const localLookup = yield* Effect.result(db.session.resolveSession(p.id))

                if (Predicate.isTagged(localLookup, "Success"))
                  return yield* new AmbiguousSession({
                    prefix: p.id,
                    matches: [localLookup.success, ...remoteMatches.map((m) => m.session)],
                  })

                if (Predicate.isTagged(localLookup.failure, "AmbiguousSession"))
                  return yield* new AmbiguousSession({
                    prefix: p.id,
                    matches: [...localLookup.failure.matches, ...remoteMatches.map((m) => m.session)],
                  })

                if (remoteMatches.length > 1)
                  return yield* new AmbiguousSession({
                    prefix: p.id,
                    matches: remoteMatches.map((m) => m.session),
                  })

                const [match] = remoteMatches
                const machineRow = yield* db.remote.machineWithRemote(match!.remote)

                if (machineRow === undefined) return yield* local(p.id)

                return yield* forwardSend(
                  p,
                  { machine: machineRow.name, id: match!.session },
                  caller.projectId,
                  REMOTE_BY_USER,
                  caller.sessionId,
                )
              })
            })
          : routed("session.send", p, local, (at, project, by) =>
              Effect.gen(function* () {
                const [targetAt, forwardBy] =
                  by === REMOTE_BY_USER
                    ? ([at, by] as const)
                    : yield* Effect.gen(function* () {
                        const machineRow = yield* db.remote.machineNamed(at.machine)

                        if (machineRow === undefined) return [at, by] as const
                        const matches = yield* db.session.resolveRemoteEdges(by, at.id, machineRow.remoteId)

                        if (matches.length === 0)
                          return yield* new Forbidden({
                            method: "session.send",
                            message: `${p.id} on ${at.machine} is not linked from this session; link them with vibest session link`,
                          })

                        if (matches.length > 1)
                          return yield* new AmbiguousSession({
                            prefix: at.id,
                            matches: matches.map((m) => m.session),
                          })

                        return [{ ...at, id: matches[0]!.session }, REMOTE_BY_USER] as const
                      })

                return yield* forwardSend(p, targetAt, project, forwardBy, by)
              }),
            ),
      interrupt: <A, E, R2>(p: SessionRef, local: Local<A, E, R2>) =>
        routed("session.interrupt", p, local, (at, project, by) =>
          remote.forward(at, project, by, (c, { id }) =>
            c["server.session"]["session.interrupt"]({ params: { id }, query: {} }),
          ),
        ),
      stop: <A, E, R2>(p: SessionRef, local: Local<A, E, R2>) =>
        routed("session.stop", p, local, (at, project, by) =>
          machines.link(at.machine).pipe(
            Effect.flatMap((link) =>
              link.capabilities.stop === true
                ? remote.forward(at, project, by, (c, { id }) =>
                    c["server.session"]["session.stop"]({ params: { id }, query: {} }),
                  )
                : Effect.fail(
                    new MachineIncompatible({
                      machine: at.machine,
                      message: `${at.machine} runs a vibest that has no vibest stop; run vibest update there`,
                    }),
                  ),
            ),
          ),
        ),
      archive: <A, E, R2>(p: SessionRef & { readonly keepWorktree?: boolean | undefined }, local: Local<A, E, R2>) =>
        routed("session.archive", p, local, (at, project, by) =>
          remote.forward(at, project, by, (c, { id }) =>
            c["server.session"]["session.archive"]({
              params: { id },
              payload: p.keepWorktree !== undefined ? { keepWorktree: p.keepWorktree } : {},
            }),
          ),
        ),
      get: <A, E, R2>(p: SessionRef, local: Local<A, E, R2>) =>
        routed("session.get", p, local, (at, project, by) => remote.get(at, project, by)),
      peek: <A, E, R2>(p: SessionRef & { readonly lines?: number | undefined }, local: Local<A, E, R2>) =>
        routed("session.peek", p, local, (at, project, by) => remote.peek(at, project, by, p)),
    },

    spawnOn: (machine: string, input: SpawnPayload, session: string, project: string) =>
      remote.spawn(machine, input, { project, session }),
  }
})

export type RoutingInterface = Effect.Success<typeof makeRouting>

export class Routing extends Context.Service<Routing, RoutingInterface>()("vibest/Routing") {}

export const routingLayer = Layer.effect(Routing, makeRouting)

export const RemoteHandler = HttpApiBuilder.group(VibestApi, "server.remote", (handlers) =>
  Effect.gen(function* () {
    const db = yield* Db.Service
    const self = yield* Identity.Service
    const { version } = yield* App.Service
    const inbound = yield* Inbound.Service
    const runtimes = yield* Runtimes.Service

    return handlers
      .handle("remote.hello", ({ payload: { id, name } }) =>
        Effect.gen(function* () {
          if ((yield* remoteOf("remote.hello")) !== id)
            return yield* new Forbidden({
              method: "remote.hello",
              message: "remote.hello names the vibestd that calls it",
            })

          if (id !== self.id) yield* db.remote.noteRemote({ id, name })

          return { id: self.id, name: self.name, version, runtimes: yield* runtimesHere(runtimes) }
        }),
      )
      .handle("remote.spawn", ({ payload: input }) =>
        Effect.gen(function* () {
          const scope = yield* remoteScope("remote.spawn")

          if (scope === undefined) return yield* notRemote("remote.spawn")

          if (scope.session === undefined)
            return yield* new Forbidden({
              method: "remote.spawn",
              message: "remote.spawn is started by a session; it is not run in the user's name",
            })

          return yield* inbound.spawn(scope.remote, scope.project, scope.session, input)
        }),
      )
      .handle("remote.outbox", () => Effect.map(remoteOf("remote.outbox"), (id) => inbound.outbox(id)))
      .handle("remote.ack", ({ payload: { ids } }) =>
        Effect.flatMap(remoteOf("remote.ack"), (id) => inbound.ack(id, ids)),
      )
      .handle("remote.link", ({ payload: { edges } }) =>
        remoteOf("remote.link").pipe(Effect.andThen(inbound.link(edges))),
      )
      .handle("remote.unlink", ({ payload: { edges } }) =>
        remoteOf("remote.unlink").pipe(Effect.andThen(inbound.unlink(edges))),
      )
  }),
)
