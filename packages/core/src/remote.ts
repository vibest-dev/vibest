import type { PipeClient } from "@vibest/client/pipe"
import { peerHeaders } from "@vibest/protocol/protocol"
import type { PayloadOf, SessionInfo } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { type ListedMachine, MachineFailed } from "@vibest/schema/machine"
import { Context, Effect, Layer } from "effect"

import { callerKind } from "./caller.ts"
import { Db } from "./db.ts"
import { Git } from "./git.ts"
import { VibestdIdentity } from "./identity.ts"
import { Machines } from "./machines.ts"
import { Plugins } from "./plugins.ts"
import { repositoryIdentity } from "./repository-url.ts"

export type Address =
  | { readonly _tag: "Local"; readonly id: string }
  | { readonly _tag: "Remote"; readonly machine: string; readonly id: string }

export const address = (input: string): Address => {
  const at = input.indexOf("/")
  return at <= 0
    ? { _tag: "Local", id: input }
    : { _tag: "Remote", machine: input.slice(0, at), id: input.slice(at + 1) }
}

export type At = Extract<Address, { readonly _tag: "Remote" }>

export type PeerScope = { readonly peer: string; readonly project: string }

export type ListScope =
  | { readonly _tag: "All" }
  | { readonly _tag: "Project"; readonly id: string }
  | { readonly _tag: "Nothing" }
  | ({ readonly _tag: "Peer" } & PeerScope)

export type Forwarded<A, E> = (
  client: PipeClient,
  at: At,
  options: { readonly headers: Record<string, string> },
) => Effect.Effect<A, E>

const addressed = (machine: string, id: string) => `${machine}/${id}`

const REFUSED = [
  ["env", "--env"],
  ["peer", "--peer"],
  ["archive", "--archive-on-completion"],
  ["agent", "--agent"],
  ["runtimeSession", "--session"],
] as const

type Away = { readonly machine: ListedMachine; readonly sessions: ReadonlyArray<SessionInfo> }

const make = Effect.gen(function* () {
  const db = yield* Db
  const machines = yield* Machines
  const self = yield* VibestdIdentity
  const git = yield* Git
  const plugins = yield* Plugins

  const call = <A, E>(
    machine: string,
    project: string,
    f: (client: PipeClient, headers: Record<string, string>) => Effect.Effect<A, E>,
  ) => Effect.flatMap(machines.link(machine), (link) => link.call(f(link.client, peerHeaders(self.id, project))))

  const relay = <A, E>(at: At, project: string, f: Forwarded<A, E>) =>
    call(at.machine, project, (client, headers) => f(client, at, { headers }))

  return {
    relay,

    forward: <A extends { readonly id: string } | null, E>(at: At, project: string, f: Forwarded<A, E>) =>
      Effect.map(relay(at, project, f), (row): A =>
        row === null ? row : { ...row, id: addressed(at.machine, row.id) },
      ),

    list: (scope: ListScope, stopped: boolean | undefined) =>
      Effect.gen(function* () {
        if (scope._tag === "Peer") return { sessions: [], machines: [] }
        const each = yield* Effect.forEach(
          yield* machines.states,
          ({ info, link }): Effect.Effect<Away> =>
            link === undefined || scope._tag !== "Project"
              ? Effect.succeed({ machine: info, sessions: [] })
              : link
                  .call(
                    link.client.List(stopped === undefined ? {} : { stopped }, {
                      headers: peerHeaders(self.id, scope.id),
                    }),
                  )
                  .pipe(
                    Effect.match({
                      onSuccess: (rows) => ({
                        machine: info,
                        sessions: rows.sessions.map((row) => ({
                          ...row,
                          id: addressed(info.name, row.id),
                          machine: info.name,
                        })),
                      }),
                      onFailure: (e) => ({
                        machine: { ...info, state: "unreachable", reason: e.message },
                        sessions: [],
                      }),
                    }),
                  ),
          { concurrency: "unbounded" },
        )
        return { sessions: each.flatMap((e) => e.sessions), machines: each.map((e) => e.machine) }
      }),

    spawn: (
      machine: string,
      input: PayloadOf<"Spawn">,
      from: { readonly project: string; readonly coordinator?: string },
    ) =>
      Effect.gen(function* () {
        const refused = REFUSED.filter(([key]) => input[key] !== undefined && input[key] !== false).map(
          ([, flag]) => flag,
        )
        if (refused.length > 0)
          return yield* new MachineFailed({ message: `${refused.join(", ")} is not sent to another machine` })
        const repositories = yield* db.projectRemote(from.project)
        const repository = repositories[0]
        if (repositories.length !== 1 || repository === undefined)
          return yield* new MachineFailed({
            message: "only a project of one repository runs agents on another machine",
          })
        const remote = repository.remote
        if (remote === null)
          return yield* new MachineFailed({
            message: `${repository.path} has no remote; another machine finds its checkout by the remote URL`,
          })
        const commit = yield* git
          .head(repository.path)
          .pipe(
            Effect.mapError(
              (e) => new MachineFailed({ message: `cannot read HEAD of ${repository.path}: ${e.message}` }),
            ),
          )
        const identity = yield* repositoryIdentity(remote)
        const main = yield* db.coordinatorOf(from.project)
        const reportTo = from.coordinator ?? main?.id
        const runtime =
          input.runtime ?? callerKind(yield* plugins.callers, input.callerEnv) ?? (main?.runtime || undefined)
        const spawned = yield* call(machine, from.project, (client, headers) =>
          client["Peer.Spawn"](
            {
              repository: remote,
              ...(identity === undefined ? {} : { identity }),
              commit,
              prompt: input.prompt,
              ...(input.harness === undefined ? {} : { harness: input.harness }),
              ...(input.provider === undefined ? {} : { provider: input.provider }),
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.name === undefined ? {} : { title: input.name }),
              ...(runtime === undefined ? {} : { runtime }),
              ...(from.coordinator === undefined ? {} : { parent: from.coordinator }),
              ...(reportTo === undefined ? {} : { reportTo }),
              request: input.request ?? randomId(),
            },
            { headers },
          ),
        )
        return {
          id: addressed(machine, spawned.session),
          harness: spawned.harness,
          ...(spawned.provider === undefined ? {} : { provider: spawned.provider }),
          ...(spawned.model === undefined ? {} : { model: spawned.model }),
          decidedBy: spawned.decidedBy,
          trace: spawned.trace,
        }
      }),
  }
})

export class Remote extends Context.Service<Remote, Effect.Success<typeof make>>()("vibest/Remote") {
  static readonly layer = Layer.effect(Remote, make)
}
