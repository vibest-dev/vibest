import { App } from "@vibest/core/app"
import { Db } from "@vibest/core/database/db"
import type { PeerScope } from "@vibest/core/database/db-remote"
import { VibestdIdentity } from "@vibest/core/identity"
import { Runtimes, runtimesHere } from "@vibest/core/runtimes"
import { PEER_BY_USER, PEER_PROJECT_HEADER } from "@vibest/protocol/protocol"
import { Caller, type CallerShape, Forbidden, type PayloadOf } from "@vibest/protocol/rpc"
import type { NotInRepository, ProjectMoved } from "@vibest/schema/session"
import { Effect, Stream } from "effect"

import type { Listing } from "../listing.ts"
import { Machines } from "../machine/machines.ts"
import { Peers } from "../machine/peer.ts"
import { address, type At, type ListScope, Remote } from "../machine/remote.ts"
import type { Checks } from "./caller.ts"

type Routed = "Send" | "Interrupt" | "Remove" | "Get" | "Peek"
type Local<A, E, R> = (id: string) => Effect.Effect<A, E, R>

const notPeer = (method: string) => new Forbidden({ method, message: `${method} is for another vibestd` })

const byOf = (c: CallerShape) => (c._tag === "Session" ? c.sessionId : PEER_BY_USER)

const peerOf = (method: string) =>
  Effect.flatMap(Caller, (c) => (c._tag === "Peer" ? Effect.succeed(c.peerId) : Effect.fail(notPeer(method))))

const peerScope = (method: string) =>
  Effect.flatMap(Caller, (c): Effect.Effect<PeerScope | undefined, Forbidden> => {
    if (c._tag !== "Peer") return Effect.succeed(undefined)
    if (c.projectId === undefined)
      return Effect.fail(
        new Forbidden({ method, message: `${method} needs the calling project (${PEER_PROJECT_HEADER})` }),
      )
    return Effect.succeed({
      peer: c.peerId,
      project: c.projectId,
      ...(c.session === undefined ? {} : { session: c.session }),
    })
  })

export const remoteHandlers = (
  deps: Pick<Checks, "agent" | "projectOf" | "findAt" | "cliOnly"> & { readonly listed: Listing["listed"] },
) =>
  Effect.gen(function* () {
    const db = yield* Db
    const self = yield* VibestdIdentity
    const { version } = yield* App
    const machines = yield* Machines
    const peers = yield* Peers
    const remote = yield* Remote
    const runtimes = yield* Runtimes
    const { cliOnly } = deps

    const reach = (method: Routed | "List") =>
      Effect.gen(function* () {
        const scope = yield* peerScope(method)
        if (scope !== undefined) return { c: undefined, scope }
        return { c: yield* deps.agent(method), scope }
      })

    const listScope = (all: boolean | undefined) =>
      Effect.gen(function* () {
        const { c, scope } = yield* reach("List")
        if (c === undefined) return { _tag: "Peer", ...scope } satisfies ListScope
        if (c._tag === "Session") return { _tag: "Project", id: c.projectId } satisfies ListScope
        if (all === true) return { _tag: "All" } satisfies ListScope
        return yield* deps.findAt(c.repositoryRoot).pipe(
          Effect.map((row): ListScope => (row === undefined ? { _tag: "Nothing" } : { _tag: "Project", id: row.id })),
          Effect.catchTag("NotInRepository", () => Effect.succeed<ListScope>({ _tag: "All" })),
        )
      })

    const refused = (method: string) => (e: NotInRepository | ProjectMoved) =>
      Effect.fail(new Forbidden({ method, message: `${method} on another machine: ${e.message}` }))

    const routed = <A, E, R2, B, F>(
      method: Routed,
      input: string,
      local: Local<A, E, R2>,
      forwarded: (at: At, project: string, by: string) => Effect.Effect<B, F>,
    ) => {
      const at = address(input)
      return at._tag === "Local"
        ? local(at.id)
        : deps.agent(method).pipe(
            Effect.flatMap((c) =>
              deps.projectOf(c, method).pipe(
                Effect.catchTags({ NotInRepository: refused(method), ProjectMoved: refused(method) }),
                Effect.flatMap((project) => forwarded(at, project.id, byOf(c))),
              ),
            ),
          )
    }

    return {
      reach,
      routed: {
        Send: <A, E, R2>(p: PayloadOf<"Send">, local: Local<A, E, R2>) =>
          routed("Send", p.id, local, (at, project, by) =>
            remote.forward(at, project, by, (c, { id }, o) => c.Send({ ...p, id }, o)),
          ),
        Interrupt: <A, E, R2>(p: PayloadOf<"Interrupt">, local: Local<A, E, R2>) =>
          routed("Interrupt", p.id, local, (at, project, by) =>
            remote.forward(at, project, by, (c, { id }, o) => c.Interrupt({ ...p, id }, o)),
          ),
        Remove: <A, E, R2>(p: PayloadOf<"Remove">, local: Local<A, E, R2>) =>
          routed("Remove", p.id, local, (at, project, by) =>
            remote.forward(at, project, by, (c, { id }, o) => c.Remove({ ...p, id }, o)),
          ),
        Get: <A, E, R2>(p: PayloadOf<"Get">, local: Local<A, E, R2>) =>
          routed("Get", p.id, local, (at, project, by) => remote.get(at, project, by, p)),
        Peek: <A, E, R2>(p: PayloadOf<"Peek">, local: Local<A, E, R2>) =>
          routed("Peek", p.id, local, (at, project, by) => remote.peek(at, project, by, p)),
      },

      spawnOn: (machine: string, input: PayloadOf<"Spawn">, session: string, project: string) =>
        remote.spawn(machine, input, { project, session }),

      methods: {
        List: ({ stopped, all }: PayloadOf<"List">) =>
          Effect.gen(function* () {
            const scope = yield* listScope(all)
            const local = yield* deps.listed(scope, stopped === true)
            const away = yield* remote.list(scope, byOf(yield* Caller), stopped)
            return { sessions: [...local, ...away.sessions], machines: away.machines }
          }),

        "Peer.Hello": ({ id, name }: PayloadOf<"Peer.Hello">) =>
          Effect.gen(function* () {
            if ((yield* peerOf("Peer.Hello")) !== id)
              return yield* new Forbidden({
                method: "Peer.Hello",
                message: "Peer.Hello names the vibestd that calls it",
              })
            if (id !== self.id) yield* db.notePeer({ id, name })
            return { id: self.id, name: self.name, version, runtimes: yield* runtimesHere(runtimes) }
          }),

        "Peer.Spawn": (input: PayloadOf<"Peer.Spawn">) =>
          Effect.gen(function* () {
            const scope = yield* peerScope("Peer.Spawn")
            if (scope === undefined) return yield* notPeer("Peer.Spawn")
            if (scope.session === undefined)
              return yield* new Forbidden({
                method: "Peer.Spawn",
                message: "Peer.Spawn is started by a session; it is not run in the user's name",
              })
            return yield* peers.spawn(scope.peer, scope.project, scope.session, input)
          }),

        "Peer.Outbox": () => Stream.unwrap(Effect.map(peerOf("Peer.Outbox"), (peer) => peers.outbox(peer))),

        "Peer.Ack": ({ ids }: PayloadOf<"Peer.Ack">) =>
          Effect.flatMap(peerOf("Peer.Ack"), (peer) => peers.ack(peer, ids)),

        "Machine.Add": ({ name, target }: PayloadOf<"Machine.Add">) =>
          cliOnly("Machine.Add").pipe(Effect.andThen(machines.add(name, target))),

        "Machine.List": () => cliOnly("Machine.List").pipe(Effect.andThen(machines.listing)),

        "Machine.Remove": ({ name }: PayloadOf<"Machine.Remove">) =>
          cliOnly("Machine.Remove").pipe(Effect.andThen(machines.remove(name))),
      },
    }
  })

export type RemoteHandlers = Effect.Success<ReturnType<typeof remoteHandlers>>
