import type { PayloadOf } from "@vibest/protocol/rpc"
import {
  AmbiguousPeer,
  NoCommit,
  NoProject,
  NoSuchPeer,
  OUTBOX_ITEM_MAX,
  type OutboxItem,
  PROMPT_MAX,
  PromptTooLarge,
} from "@vibest/schema/machine"
import { NoRuntime } from "@vibest/schema/session"
import { Context, Deferred, Effect, Layer, Stream } from "effect"

import { Bus } from "./bus.ts"
import { Db, type OutboxRow } from "./db.ts"
import { Git } from "./git.ts"
import { VibestdIdentity } from "./identity.ts"
import { defaultSessionName, Sessions } from "./sessions.ts"

export const outboxItem = (row: OutboxRow): OutboxItem => {
  const base = { id: row.id, session: row.sessionId, recipient: row.reportTo, kind: row.kind }
  const { read } = new TextEncoder().encodeInto(row.content, new Uint8Array(OUTBOX_ITEM_MAX))
  return read === row.content.length
    ? { ...base, content: row.content }
    : { ...base, content: row.content.slice(0, read), cut: true }
}

const make = Effect.gen(function* () {
  const db = yield* Db
  const bus = yield* Bus
  const sessions = yield* Sessions
  const self = yield* VibestdIdentity
  const git = yield* Git
  const open = new Map<string, Set<Deferred.Deferred<void>>>()

  const resolvePeer = (input: string) =>
    Effect.gen(function* () {
      const rows = yield* db.peers
      const exact = rows.find((p) => p.id === input)
      if (exact !== undefined) return exact.id
      const matches = rows.filter((p) => (input.length >= 8 && p.id.startsWith(input)) || p.name === input)
      if (matches.length === 0) return yield* new NoSuchPeer({ peer: input })
      if (matches.length > 1) return yield* new AmbiguousPeer({ peer: input, matches: matches.map((p) => p.id) })
      return matches[0]!.id
    })

  return {
    spawn: (peer: string, project: string, input: PayloadOf<"Peer.Spawn">) =>
      Effect.gen(function* () {
        const bytes = new TextEncoder().encode(input.prompt).length
        if (bytes > PROMPT_MAX) return yield* new PromptTooLarge({ bytes })
        const found = yield* db.projectsWithRemote(input.repository)
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
            harness: input.harness,
            provider: input.provider,
            model: input.model,
            runtime: input.runtime,
            request: input.request,
            commit: input.commit,
            origin: { peer, project, parent: input.parent, reportTo: input.reportTo },
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
          const subscription = yield* bus.subscribe
          const stop = yield* Deferred.make<void>()
          const streams = open.get(peer) ?? new Set()
          open.set(peer, streams.add(stop))
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              streams.delete(stop)
              if (streams.size === 0 && open.get(peer) === streams) open.delete(peer)
            }),
          )
          const sent = new Set<string>()
          const batch = Effect.gen(function* () {
            const rows = yield* db.outboxOf(peer)
            const present = new Set(rows.map((row) => row.id))
            for (const id of sent) if (!present.has(id)) sent.delete(id)
            const fresh = rows.filter((row) => !sent.has(row.id))
            for (const row of fresh) sent.add(row.id)
            return fresh.map(outboxItem)
          })
          const wake = Stream.fromSubscription(subscription).pipe(
            Stream.filter((event) => event.type === "live.outbox" && event.peerId === peer),
          )
          return Stream.concat(Stream.make(undefined), wake).pipe(
            Stream.mapEffect(() => batch),
            Stream.flattenIterable,
            Stream.interruptWhen(Deferred.await(stop)),
          )
        }),
      ),

    ack: (peer: string, ids: ReadonlyArray<string>) => db.ackOutbox(peer, ids),

    list: Effect.map(db.peers, (rows) => rows.map((row) => ({ ...row, connected: (open.get(row.id)?.size ?? 0) > 0 }))),

    remove: (input: string) =>
      Effect.gen(function* () {
        const id = yield* resolvePeer(input)
        const outbox = yield* db.removePeer(id)
        for (const stop of open.get(id) ?? []) yield* Deferred.succeed(stop, undefined)
        open.delete(id)
        return { outbox }
      }),
  }
})

export class Peers extends Context.Service<Peers, Effect.Success<typeof make>>()("vibest/Peers") {
  static readonly layer = Layer.effect(Peers, make)
}
