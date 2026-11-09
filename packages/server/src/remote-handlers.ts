import { Db } from "@vibest/core/db"
import { VibestdIdentity } from "@vibest/core/identity"
import { Machines } from "@vibest/core/machines"
import { Peers } from "@vibest/core/peer"
import { type Address, address, Remote } from "@vibest/core/remote"
import { PEER_PROJECT_HEADER } from "@vibest/protocol/protocol"
import { type ACCESS, Caller, Forbidden, VERSION } from "@vibest/protocol/rpc"
import { Effect, Stream } from "effect"

type Access = typeof ACCESS
type Levels<X> = Exclude<X extends ReadonlyArray<infer L> ? L : X, "peer">
export type MethodOf<A> = {
  [K in keyof Access]: [Levels<Access[K]>] extends [never] ? never : Levels<Access[K]> extends A ? K : never
}[keyof Access]

export const remoteHandlers = <E, R>(deps: {
  readonly project: (method: MethodOf<"agent" | "owner">) => Effect.Effect<string, E, R>
  readonly cliOnly: (method: MethodOf<"cli">) => Effect.Effect<void, Forbidden, Caller>
}) =>
  Effect.gen(function* () {
    const db = yield* Db
    const self = yield* VibestdIdentity
    const machines = yield* Machines
    const peers = yield* Peers
    const remote = yield* Remote
    const { cliOnly } = deps

    const peerCaller = (method: string) =>
      Effect.flatMap(Caller, (c) =>
        c._tag === "Peer"
          ? Effect.succeed({ peer: c.peerId, project: c.projectId })
          : Effect.fail(new Forbidden({ method, message: `${method} is for another vibestd` })),
      )

    const peerScope = (method: string) =>
      Effect.flatMap(peerCaller(method), ({ peer, project }) =>
        project === undefined
          ? Effect.fail(
              new Forbidden({ method, message: `${method} needs the calling project (${PEER_PROJECT_HEADER})` }),
            )
          : Effect.succeed({ peer, project }),
      )

    const peerSession = (method: string, input: string) =>
      peerScope(method).pipe(Effect.flatMap((scope) => db.resolveSession(input, scope)))

    const remoteProject = (method: MethodOf<"agent" | "owner">) =>
      deps.project(method).pipe(
        Effect.catchIf(
          (e): e is Exclude<E, Forbidden> => !(e instanceof Forbidden),
          (e) =>
            Effect.fail(
              new Forbidden({
                method,
                message: `${method} on another machine: ${(e as { message?: string }).message}`,
              }),
            ),
        ),
      )

    const routed = <A, E1, R, B, F>(
      method: MethodOf<"agent" | "owner">,
      input: string,
      local: (id: string) => Effect.Effect<A, E1, R>,
      forwarded: (at: Extract<Address, { _tag: "Remote" }>, project: string) => Effect.Effect<B, F>,
    ) => {
      const at = address(input)
      return at._tag === "Local"
        ? local(at.id)
        : Effect.flatMap(remoteProject(method), (project) => forwarded(at, project))
    }

    return {
      remote,
      routed,
      peerScope,
      peerSession,
      methods: {
        "Peer.Hello": ({
          id,
          name,
          callsMe,
        }: {
          readonly id: string
          readonly name: string
          readonly callsMe: string
        }) =>
          Effect.gen(function* () {
            if ((yield* peerCaller("Peer.Hello")).peer !== id)
              return yield* new Forbidden({
                method: "Peer.Hello",
                message: "Peer.Hello names the vibestd that calls it",
              })
            if (id !== self.id) yield* db.notePeer({ id, name, callsMe })
            return { id: self.id, name: self.name, version: VERSION }
          }),

        "Peer.Spawn": (input: Parameters<Peers["Service"]["spawn"]>[2]) =>
          peerScope("Peer.Spawn").pipe(Effect.flatMap(({ peer, project }) => peers.spawn(peer, project, input))),

        "Peer.Outbox": () => Stream.unwrap(Effect.map(peerCaller("Peer.Outbox"), ({ peer }) => peers.outbox(peer))),

        "Peer.Ack": ({ ids }: { readonly ids: ReadonlyArray<string> }) =>
          Effect.flatMap(peerCaller("Peer.Ack"), ({ peer }) => peers.ack(peer, ids)),

        "Peers.List": () => cliOnly("Peers.List").pipe(Effect.andThen(peers.list)),

        "Peers.Remove": ({ peer }: { readonly peer: string }) =>
          cliOnly("Peers.Remove").pipe(Effect.andThen(peers.remove(peer))),

        "Machine.Add": ({ name, target }: { readonly name: string; readonly target: string }) =>
          cliOnly("Machine.Add").pipe(Effect.andThen(machines.add(name, target))),

        "Machine.List": () =>
          cliOnly("Machine.List").pipe(
            Effect.andThen(machines.states),
            Effect.map((states) => states.map((s) => s.info)),
          ),

        "Machine.Remove": ({ name }: { readonly name: string }) =>
          cliOnly("Machine.Remove").pipe(Effect.andThen(machines.remove(name))),
      },
    }
  })
