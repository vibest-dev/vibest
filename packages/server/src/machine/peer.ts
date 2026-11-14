import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import type { OutboxRow } from "@vibest/core/database/db-remote"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Git } from "@vibest/core/git"
import { Identity } from "@vibest/core/identity"
import { repositoryIdentity } from "@vibest/core/repository-url"
import { defaultSessionName, Session } from "@vibest/core/session"
import type { PayloadOf } from "@vibest/protocol/rpc"
import { OutboxQueued } from "@vibest/schema/event"
import {
  NoCommit,
  NoProject,
  OUTBOX_ITEM_MAX,
  type OutboxItem,
  PROMPT_MAX,
  PromptTooLarge,
} from "@vibest/schema/machine"
import { NoRuntime } from "@vibest/schema/session"
import { Context, Effect, Layer, Option, Queue, Stream } from "effect"

export * as Peer from "./peer.ts"

export const OUTBOX_PAGE = 100

const outboxItem = (row: OutboxRow): OutboxItem => {
  const base = { id: row.id, session: row.sessionId, recipient: row.reportTo, kind: row.kind }
  const { read } = new TextEncoder().encodeInto(row.content, new Uint8Array(OUTBOX_ITEM_MAX))
  return read === row.content.length
    ? { ...base, content: row.content }
    : { ...base, content: row.content.slice(0, read), cut: true }
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const bus = yield* Bus
  const sessions = yield* Session.Service
  const self = yield* Identity.Service
  const git = yield* Git.Service

  return {
    spawn: Effect.fn("Peer.spawn")(function* (
      peer: string,
      project: string,
      reportTo: string,
      input: PayloadOf<"Peer.Spawn">,
    ) {
      const bytes = new TextEncoder().encode(input.prompt).length
      if (bytes > PROMPT_MAX) return yield* new PromptTooLarge({ bytes })
      const rows = yield* db.remoteProjects
      const exact = rows.filter((row) => row.remote === input.repository)
      const { identity } = input
      const matched =
        exact.length > 0 || identity === undefined
          ? exact
          : (yield* Effect.forEach(
              rows,
              (row) => Effect.map(repositoryIdentity(row.remote), (id) => (id === identity ? [row] : [])),
              { concurrency: 8 },
            )).flat()
      const found = matched.filter((row, i) => matched.findIndex((other) => other.id === row.id) === i)
      const here = `${self.name} has no checkout of ${input.repository}: clone it there and run vibest project add in it`
      if (found.length === 0) return yield* new NoProject({ message: here })
      if (found.length > 1)
        return yield* new NoProject({
          message: `${self.name} has several projects for ${input.repository}: ${found.map((p) => p.directory ?? p.id).join(", ")}`,
        })
      const target = found[0]!
      if (target.repositories !== 1 || target.directory === null)
        return yield* new NoProject({
          message: `${self.name}'s project for ${input.repository} has several repositories; another machine runs agents only in a single-repository project`,
        })
      if (!(yield* git.hasCommit(target.directory, input.commit)))
        return yield* new NoCommit({
          message: `${self.name}'s checkout ${target.directory} does not have ${input.commit}: push it and fetch it there`,
        })
      const spawned = yield* sessions
        .spawn({
          machine: { id: "local" },
          root: target.directory,
          projectId: target.id,
          name: input.title ?? defaultSessionName(input.prompt),
          prompt: input.prompt,
          agent: input.agent,
          harness: input.harness,
          provider: input.provider,
          model: input.model,
          runtime: input.runtime,
          request: input.request,
          commit: input.commit,
          origin: { peer, project, reportTo },
        })
        .pipe(Effect.catchTag("NoRuntime", (e) => new NoRuntime({ message: `${self.name}: ${e.message}` })))
      return {
        session: spawned.id,
        harness: spawned.harness,
        ...(spawned.provider === undefined ? {} : { provider: spawned.provider }),
        ...(spawned.model === undefined ? {} : { model: spawned.model }),
        directory: target.directory,
        decidedBy: spawned.decidedBy,
        trace: spawned.trace,
      }
    }),

    outbox: (peer: string): Stream.Stream<OutboxItem> =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* bus.subscribe([OutboxQueued])
          const slot = yield* Queue.sliding<void>(1)
          yield* Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.data.peer === peer),
            Stream.runForEach(() => Queue.offer(slot, undefined)),
            Effect.forkScoped,
          )
          let cursor = 0
          const pages = Stream.paginate(undefined, () =>
            db.outboxOf(peer, cursor, OUTBOX_PAGE).pipe(
              Effect.map((rows) => {
                cursor = rows.at(-1)?.seq ?? cursor
                return [
                  rows.map(outboxItem),
                  rows.length < OUTBOX_PAGE ? Option.none() : Option.some(undefined),
                ] as const
              }),
            ),
          )
          return Stream.concat(Stream.make(undefined), Stream.fromQueue(slot)).pipe(
            Stream.flatMap(() => pages, { concurrency: 1 }),
          )
        }),
      ),

    ack: Effect.fn("Peer.ack")((peer: string, ids: ReadonlyArray<string>) => db.ackOutbox(peer, ids)),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/Peers") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [Bus.node, Db.node, Git.node, Session.node, Identity.node],
})
