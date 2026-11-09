import { Db } from "@vibest/core/db"
import { VibestdIdentity } from "@vibest/core/identity"
import { Machines } from "@vibest/core/machines"
import { Peers } from "@vibest/core/peer"
import { address, type At, type ListScope, type PeerScope, Remote } from "@vibest/core/remote"
import type { NotInRepository } from "@vibest/core/worktree"
import { PEER_PROJECT_HEADER } from "@vibest/protocol/protocol"
import { Caller, type CallerShape, Forbidden, type PayloadOf, type SessionInfo, VERSION } from "@vibest/protocol/rpc"
import type { ProjectMoved } from "@vibest/schema/session"
import { Effect, Stream } from "effect"

type Routed = "Send" | "Interrupt" | "Remove" | "Get" | "Peek"
type CliOnly = "Machine.Add" | "Machine.List" | "Machine.Remove"
type Agent = Extract<CallerShape, { _tag: "Cli" | "Coordinator" }>
type Local<A, E, R> = (id: string) => Effect.Effect<A, E, R>

const notPeer = (method: string) => new Forbidden({ method, message: `${method} is for another vibestd` })

const peerOf = (method: string) =>
  Effect.flatMap(Caller, (c) => (c._tag === "Peer" ? Effect.succeed(c.peerId) : Effect.fail(notPeer(method))))

const peerScope = (method: string) =>
  Effect.flatMap(Caller, (c): Effect.Effect<PeerScope | undefined, Forbidden> => {
    if (c._tag !== "Peer") return Effect.succeed(undefined)
    if (c.projectId === undefined)
      return Effect.fail(
        new Forbidden({ method, message: `${method} needs the calling project (${PEER_PROJECT_HEADER})` }),
      )
    return Effect.succeed({ peer: c.peerId, project: c.projectId })
  })

export const remoteHandlers = <R>(deps: {
  readonly agent: (method: Routed | "List") => Effect.Effect<Agent, Forbidden, Caller>
  readonly projectOf: (
    c: Agent,
    method: Routed,
  ) => Effect.Effect<{ readonly id: string }, Forbidden | NotInRepository | ProjectMoved, R>
  readonly findAt: (directory: string) => Effect.Effect<{ readonly id: string } | undefined, NotInRepository, R>
  readonly listed: (scope: ListScope, stopped: boolean) => Effect.Effect<ReadonlyArray<SessionInfo>, never, R>
  readonly cliOnly: (method: CliOnly) => Effect.Effect<void, Forbidden, Caller>
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const self = yield* VibestdIdentity
    const machines = yield* Machines
    const peers = yield* Peers
    const remote = yield* Remote
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
        if (c._tag === "Coordinator") return { _tag: "Project", id: c.projectId } satisfies ListScope
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
      forwarded: (at: At, project: string) => Effect.Effect<B, F>,
    ) => {
      const at = address(input)
      return at._tag === "Local"
        ? local(at.id)
        : deps.agent(method).pipe(
            Effect.flatMap((c) => deps.projectOf(c, method)),
            Effect.catchTags({ NotInRepository: refused(method), ProjectMoved: refused(method) }),
            Effect.flatMap((project) => forwarded(at, project.id)),
          )
    }

    return {
      reach,
      routed: {
        Send: <A, E, R2>(p: PayloadOf<"Send">, local: Local<A, E, R2>) =>
          routed("Send", p.id, local, (at, project) =>
            remote.forward(at, project, (c, { id }, o) => c.Send({ ...p, id }, o)),
          ),
        Interrupt: <A, E, R2>(p: PayloadOf<"Interrupt">, local: Local<A, E, R2>) =>
          routed("Interrupt", p.id, local, (at, project) =>
            remote.forward(at, project, (c, { id }, o) => c.Interrupt({ ...p, id }, o)),
          ),
        Remove: <A, E, R2>(p: PayloadOf<"Remove">, local: Local<A, E, R2>) =>
          routed("Remove", p.id, local, (at, project) =>
            remote.forward(at, project, (c, { id }, o) => c.Remove({ ...p, id }, o)),
          ),
        Get: <A, E, R2>(p: PayloadOf<"Get">, local: Local<A, E, R2>) =>
          routed("Get", p.id, local, (at, project) =>
            remote
              .forward(at, project, (c, { id }, o) => c.Get({ ...p, id }, o))
              .pipe(Effect.map((row) => ({ ...row, machine: at.machine }))),
          ),
        Peek: <A, E, R2>(p: PayloadOf<"Peek">, local: Local<A, E, R2>) =>
          routed("Peek", p.id, local, (at, project) =>
            remote.relay(at, project, (c, { id }, o) => c.Peek({ ...p, id }, o)),
          ),
      },

      spawnOn: (machine: string, input: PayloadOf<"Spawn">, caller: Agent, project: string) =>
        remote.spawn(machine, input, {
          project,
          ...(caller._tag === "Coordinator" ? { coordinator: caller.sessionId } : {}),
        }),

      methods: {
        List: ({ stopped, all }: PayloadOf<"List">) =>
          Effect.gen(function* () {
            const scope = yield* listScope(all)
            const local = yield* deps.listed(scope, stopped === true)
            const away = yield* remote.list(scope, stopped)
            return { sessions: [...local, ...away.sessions], machines: away.machines }
          }),

        "Peer.Hello": ({ id, name, callsMe }: PayloadOf<"Peer.Hello">) =>
          Effect.gen(function* () {
            if ((yield* peerOf("Peer.Hello")) !== id)
              return yield* new Forbidden({
                method: "Peer.Hello",
                message: "Peer.Hello names the vibestd that calls it",
              })
            if (id !== self.id) yield* db.notePeer({ id, name, callsMe })
            return { id: self.id, name: self.name, version: VERSION }
          }),

        "Peer.Spawn": (input: PayloadOf<"Peer.Spawn">) =>
          Effect.gen(function* () {
            const scope = yield* peerScope("Peer.Spawn")
            if (scope === undefined) return yield* notPeer("Peer.Spawn")
            return yield* peers.spawn(scope.peer, scope.project, input)
          }),

        "Peer.Outbox": () => Stream.unwrap(Effect.map(peerOf("Peer.Outbox"), (peer) => peers.outbox(peer))),

        "Peer.Ack": ({ ids }: PayloadOf<"Peer.Ack">) =>
          Effect.flatMap(peerOf("Peer.Ack"), (peer) => peers.ack(peer, ids)),

        "Machine.Add": ({ name, target }: PayloadOf<"Machine.Add">) =>
          cliOnly("Machine.Add").pipe(Effect.andThen(machines.add(name, target))),

        "Machine.List": () =>
          cliOnly("Machine.List").pipe(
            Effect.andThen(machines.states),
            Effect.map((states) => states.map((s) => s.info)),
          ),

        "Machine.Remove": ({ name }: PayloadOf<"Machine.Remove">) =>
          cliOnly("Machine.Remove").pipe(Effect.andThen(machines.remove(name))),
      },
    }
  })
