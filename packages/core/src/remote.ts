import type { PipeClient } from "@vibest/client/pipe"
import { peerHeaders } from "@vibest/protocol/protocol"
import type { SessionInfo } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { type ListedMachine, MachineFailed } from "@vibest/schema/machine"
import { Context, Effect, Layer } from "effect"

import { Db } from "./db.ts"
import { Git } from "./git.ts"
import { VibestdIdentity } from "./identity.ts"
import { Machines } from "./machines.ts"
import type { SpawnInput } from "./sessions.ts"

export type Address =
  | { readonly _tag: "Local"; readonly id: string }
  | { readonly _tag: "Remote"; readonly machine: string; readonly id: string }

export const address = (input: string): Address => {
  const at = input.indexOf("/")
  return at <= 0
    ? { _tag: "Local", id: input }
    : { _tag: "Remote", machine: input.slice(0, at), id: input.slice(at + 1) }
}

type At = Extract<Address, { readonly _tag: "Remote" }>

export type RemoteSpawn = {
  readonly prompt: string
  readonly env?: unknown
  readonly peer?: string | undefined
  readonly archive?: boolean | undefined
  readonly harness?: SpawnInput["harness"]
  readonly provider?: string | undefined
  readonly model?: string | undefined
  readonly name?: string | undefined
  readonly runtime?: string | undefined
  readonly request?: string | undefined
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const machines = yield* Machines
  const self = yield* VibestdIdentity
  const git = yield* Git

  const call = <A, E>(
    machine: string,
    project: string,
    f: (client: PipeClient, headers: Record<string, string>) => Effect.Effect<A, E>,
  ) => Effect.flatMap(machines.link(machine), (link) => link.call(f(link.client, peerHeaders(self.id, project))))

  const named = <S extends { readonly id: string }>(machine: string, row: S) => ({
    ...row,
    id: `${machine}/${row.id}`,
    machine,
  })

  const listed = (info: ListedMachine & { readonly reason?: string | undefined }): ListedMachine => ({
    name: info.name,
    state: info.state,
    since: info.since,
    ...(info.reason === undefined ? {} : { reason: info.reason }),
  })

  return {
    send: (at: At, project: string, input: { readonly message: string; readonly request?: string }) =>
      call(at.machine, project, (client, headers) => client.Send({ ...input, id: at.id }, { headers })).pipe(
        Effect.map((sent) => ({ id: `${at.machine}/${sent.id}` })),
      ),

    interrupt: (at: At, project: string) =>
      call(at.machine, project, (client, headers) => client.Interrupt({ id: at.id }, { headers })).pipe(
        Effect.map((out) => ({ ...out, id: `${at.machine}/${out.id}` })),
      ),

    remove: (at: At, project: string, input: { readonly keepWorktree?: boolean }) =>
      call(at.machine, project, (client, headers) => client.Remove({ ...input, id: at.id }, { headers })),

    get: (at: At, project: string) =>
      call(at.machine, project, (client, headers) => client.Get({ id: at.id }, { headers })).pipe(
        Effect.map((row) => named(at.machine, row)),
      ),

    peek: (at: At, project: string, input: { readonly lines?: number }) =>
      call(at.machine, project, (client, headers) => client.Peek({ ...input, id: at.id }, { headers })),

    list: (project: string | undefined, stopped: boolean | undefined) =>
      Effect.gen(function* () {
        const states = yield* machines.states
        const each = yield* Effect.forEach(
          states,
          ({ info, link }) =>
            link === undefined || project === undefined
              ? Effect.succeed({ machine: listed(info), sessions: [] as Array<SessionInfo> })
              : link
                  .call(
                    link.client.List(stopped === undefined ? {} : { stopped }, {
                      headers: peerHeaders(self.id, project),
                    }),
                  )
                  .pipe(
                    Effect.match({
                      onSuccess: (rows) => ({
                        machine: listed(info),
                        sessions: rows.sessions.map((row) => named(info.name, row)),
                      }),
                      onFailure: (e) => ({ machine: listed({ ...info, reason: e.message }), sessions: [] }),
                    }),
                  ),
          { concurrency: "unbounded" },
        )
        return { sessions: each.flatMap((e) => e.sessions), machines: each.map((e) => e.machine) }
      }),

    spawn: (machine: string, input: RemoteSpawn, from: { readonly project: string; readonly coordinator?: string }) =>
      Effect.gen(function* () {
        const refused = [
          input.env === undefined ? undefined : "--env",
          input.peer === undefined ? undefined : "--peer",
          input.archive ? "--archive-on-completion" : undefined,
        ].filter((flag) => flag !== undefined)
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
        const reportTo = from.coordinator ?? (yield* db.coordinatorOf(from.project))?.id
        const spawned = yield* call(machine, from.project, (client, headers) =>
          client["Peer.Spawn"](
            {
              repository: remote,
              commit,
              prompt: input.prompt,
              ...(input.harness === undefined ? {} : { harness: input.harness }),
              ...(input.provider === undefined ? {} : { provider: input.provider }),
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.name === undefined ? {} : { title: input.name }),
              ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
              ...(from.coordinator === undefined ? {} : { parent: from.coordinator }),
              ...(reportTo === undefined ? {} : { reportTo }),
              request: input.request ?? randomId(),
            },
            { headers },
          ),
        )
        return {
          id: spawned.session,
          harness: spawned.harness,
          ...(spawned.provider === undefined ? {} : { provider: spawned.provider }),
          ...(spawned.model === undefined ? {} : { model: spawned.model }),
          machine,
          decidedBy: spawned.decidedBy,
          trace: spawned.trace,
        }
      }),
  }
})

export class Remote extends Context.Service<Remote, Effect.Success<typeof make>>()("vibest/Remote") {
  static readonly layer = Layer.effect(Remote, make)
}
