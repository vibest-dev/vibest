import type { PipeClient } from "@vibest/client/pipe"
import { callerKind } from "@vibest/core/caller"
import { Db } from "@vibest/core/database/db"
import type { PeerScope } from "@vibest/core/database/remote"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Git } from "@vibest/core/git"
import { Identity } from "@vibest/core/identity"
import { repositoryIdentity } from "@vibest/core/repository-url"
import { Runtimes } from "@vibest/core/runtimes"
import { peerHeaders } from "@vibest/protocol/protocol"
import type { PayloadOf, SessionInfo } from "@vibest/protocol/rpc"
import { randomId } from "@vibest/schema/id"
import { type ListedMachine, MachineFailed } from "@vibest/schema/machine"
import { Context, Effect, Layer } from "effect"

import { Machines } from "./machines.ts"

export * as Remote from "./remote.ts"

type Address =
  | { readonly _tag: "Local"; readonly id: string }
  | { readonly _tag: "Remote"; readonly machine: string; readonly id: string }

export const address = (input: string): Address => {
  const at = input.indexOf("/")
  return at <= 0
    ? { _tag: "Local", id: input }
    : { _tag: "Remote", machine: input.slice(0, at), id: input.slice(at + 1) }
}

export type At = Extract<Address, { readonly _tag: "Remote" }>

export type ListScope =
  | { readonly _tag: "All" }
  | { readonly _tag: "Project"; readonly id: string }
  | { readonly _tag: "Nothing" }
  | ({ readonly _tag: "Peer" } & PeerScope)

type Forwarded<A, E> = (
  client: PipeClient,
  at: At,
  options: { readonly headers: Record<string, string> },
) => Effect.Effect<A, E>

const addressed = (machine: string, id: string) => `${machine}/${id}`

const REFUSED = [
  ["env", "--env"],
  ["share", "--share"],
  ["archive", "--archive-on-idle"],
  ["runtimeSession", "--session"],
] as const

type Away = { readonly machine: ListedMachine; readonly sessions: ReadonlyArray<SessionInfo> }

const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const machines = yield* Machines.Service
  const self = yield* Identity.Service
  const git = yield* Git.Service
  const runtimes = yield* Runtimes.Service

  const view = <R extends SessionInfo>(name: string, rows: ReadonlyArray<R>) =>
    Effect.gen(function* () {
      const shown = rows.filter((row) => row.address.id !== "")
      const kinds = [...new Set(shown.map((row) => row.runtime))]
      const views = new Map(
        yield* Effect.forEach(
          kinds,
          (kind) =>
            machines
              .ensure(
                name,
                kind,
                new Map(shown.filter((row) => row.runtime === kind).map((row) => [row.id, row.address.id])),
              )
              .pipe(Effect.map((found) => [kind, found] as const)),
          { concurrency: "unbounded" },
        ),
      )
      return rows.map((row): R => {
        const found = row.address.id === "" ? undefined : views.get(row.runtime)
        const terminal = found?.terminals.get(row.id)
        return {
          ...row,
          id: addressed(name, row.id),
          machine: name,
          address: terminal === undefined ? { machine: name, id: "" } : { machine: "local", id: terminal.id },
          ...(terminal === undefined && found?.note !== undefined ? { view: found.note } : {}),
        }
      })
    })

  const call = <A, E>(
    machine: string,
    project: string,
    by: string,
    f: (client: PipeClient, headers: Record<string, string>) => Effect.Effect<A, E>,
  ) => Effect.flatMap(machines.link(machine), (link) => link.call(f(link.client, peerHeaders(self.id, project, by))))

  const relay = Effect.fn("Remote.relay")(<A, E>(at: At, project: string, by: string, f: Forwarded<A, E>) =>
    call(at.machine, project, by, (client, headers) => f(client, at, { headers })),
  )

  return {
    relay,

    forward: Effect.fn("Remote.forward")(
      <A extends { readonly id: string } | null, E>(at: At, project: string, by: string, f: Forwarded<A, E>) =>
        Effect.map(relay(at, project, by, f), (row): A =>
          row === null ? row : { ...row, id: addressed(at.machine, row.id) },
        ),
    ),

    harnesses: Effect.fn("Remote.harnesses")((machine: string, provider: string | undefined) =>
      Effect.flatMap(machines.link(machine), (link) =>
        link.call(
          link.client["Harnesses.List"](provider === undefined ? {} : { provider }, { headers: peerHeaders(self.id) }),
        ),
      ),
    ),

    list: Effect.fn("Remote.list")(function* (scope: ListScope, by: string, stopped: boolean | undefined) {
      if (scope._tag === "Peer") return { sessions: [], machines: [] }
      const each = yield* Effect.forEach(
        yield* machines.states,
        ({ info, link }): Effect.Effect<Away> =>
          link === undefined || scope._tag !== "Project"
            ? Effect.succeed({ machine: info, sessions: [] })
            : link
                .call(
                  link.client.List(stopped === undefined ? {} : { stopped }, {
                    headers: peerHeaders(self.id, scope.id, by),
                  }),
                )
                .pipe(
                  Effect.matchEffect({
                    onSuccess: (rows) =>
                      Effect.map(view(info.name, rows.sessions), (sessions) => ({ machine: info, sessions })),
                    onFailure: (e) =>
                      Effect.succeed({
                        machine: { ...info, state: "unreachable" as const, reason: e.message },
                        sessions: [],
                      }),
                  }),
                ),
        { concurrency: "unbounded" },
      )
      return { sessions: each.flatMap((e) => e.sessions), machines: each.map((e) => e.machine) }
    }),

    get: Effect.fn("Remote.get")((at: At, project: string, by: string, p: PayloadOf<"Get">) =>
      relay(at, project, by, (c, { id }, o) => c.Get({ ...p, id }, o)).pipe(
        Effect.flatMap((row) => Effect.map(view(at.machine, [row]), (rows) => rows[0]!)),
      ),
    ),

    peek: Effect.fn("Remote.peek")(function* (at: At, project: string, by: string, p: PayloadOf<"Peek">) {
      const { text } = yield* relay(at, project, by, (c, { id }, o) => c.Peek({ ...p, id }, o))
      const row = yield* relay(at, project, by, (c, { id }, o) => c.Get({ id }, o)).pipe(
        Effect.flatMap((row) => view(at.machine, [row])),
        Effect.map((rows) => rows[0]),
        Effect.orElseSucceed(() => undefined),
      )
      return {
        text,
        ...(row === undefined || row.address.id === "" ? {} : { terminal: row.address.id }),
        ...(row?.view === undefined ? {} : { view: row.view }),
      }
    }),

    spawn: Effect.fn("Remote.spawn")(function* (
      machine: string,
      input: PayloadOf<"Spawn">,
      from: { readonly project: string; readonly session: string },
    ) {
      const refused = REFUSED.filter(([key]) => input[key] !== undefined && input[key] !== false).map(
        ([, flag]) => flag,
      )
      if (refused.length > 0)
        return yield* new MachineFailed({ message: `${refused.join(", ")} is not sent to another machine` })
      const repositories = yield* db.project.projectRemote(from.project)
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
      const runtime = input.runtime ?? callerKind(yield* runtimes.callers, input.callerEnv)
      const viewer = runtime === undefined ? undefined : (yield* runtimes.all).find((r) => r.id === runtime)
      const ready =
        viewer?.locate === undefined || runtime === undefined
          ? undefined
          : yield* machines.ensure(machine, runtime, new Map(), true)
      const spawned = yield* call(machine, from.project, from.session, (client, headers) =>
        client["Peer.Spawn"](
          {
            repository: remote,
            ...(identity === undefined ? {} : { identity }),
            commit,
            agent: input.agent,
            prompt: input.prompt,
            ...(input.harness === undefined ? {} : { harness: input.harness }),
            ...(input.provider === undefined ? {} : { provider: input.provider }),
            ...(input.model === undefined ? {} : { model: input.model }),
            ...(input.name === undefined ? {} : { title: input.name }),
            ...(runtime === undefined ? {} : { runtime }),
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
        ...(ready?.note === undefined ? {} : { notes: [{ message: ready.note }] }),
      }
    }),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Remote") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Db.node, Git.node, Machines.node, Runtimes.node, Identity.node],
})
