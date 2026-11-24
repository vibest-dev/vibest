import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import type { OutboxRow } from "@vibest/core/database/remote"
import { LayerNode } from "@vibest/core/effect/layer-node"
import { Git } from "@vibest/core/git"
import { Identity } from "@vibest/core/identity"
import { safeRepositoryDirectory, sameWorktreeBucket } from "@vibest/core/paths"
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

type Wanted = {
  readonly folder?: string | undefined
  readonly repository: string
  readonly identity?: string | undefined
  readonly commit: string
}

type Checkout = Effect.Success<Db.Interface["remote"]["projectCheckouts"]>[number] & {
  readonly remote: string | undefined
}

type Paired = { readonly wanted: Wanted; readonly row: Checkout }

const wantedOf = (input: PayloadOf<"Peer.Spawn">): ReadonlyArray<Wanted> =>
  input.repositories ??
  (input.repository === undefined || input.commit === undefined
    ? []
    : [{ repository: input.repository, identity: input.identity, commit: input.commit }])

const repositoriesNamed = (wanted: ReadonlyArray<Wanted>) => wanted.map((w) => w.repository).join(", ")

const pinned = ({ wanted, row }: Paired) => ({
  name: wanted.folder ?? row.path.slice(row.path.lastIndexOf("/") + 1),
  path: row.path,
  commit: wanted.commit,
})

const outboxItem = (row: OutboxRow): OutboxItem => {
  const base = {
    id: row.id,
    session: row.sessionId,
    recipient: row.reportTo,
    kind: row.kind,
    ...(row.from !== null && { from: row.from }),
  }

  const { read } = new TextEncoder().encodeInto(row.content, new Uint8Array(OUTBOX_ITEM_MAX))

  return read === row.content.length
    ? { ...base, content: row.content }
    : { ...base, content: row.content.slice(0, read), cut: true }
}

const make = Effect.gen(function* () {
  const db = yield* Db.Service
  const bus = yield* Bus.Service
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
      const wanted = wantedOf(input)

      if (wanted.length === 0) return yield* new NoProject({ message: `${self.name} got no repository to run in` })
      const folders = wanted.flatMap((w) => (w.folder === undefined ? [] : [w.folder]))

      const clashing = folders.some((f, i) => folders.findIndex((g) => sameWorktreeBucket(f, g)) !== i)

      if (!folders.every(safeRepositoryDirectory) || clashing)
        return yield* new NoProject({ message: `${self.name} refuses the folder names ${folders.join(", ")}` })

      const rows: ReadonlyArray<Checkout> = yield* Effect.forEach(
        yield* db.remote.projectCheckouts,
        (row) => Effect.map(git.remoteUrl(row.path), (remote) => ({ ...row, remote })),
        { concurrency: 8 },
      )

      const identities = new Map(
        wanted.some((w) => w.identity !== undefined)
          ? yield* Effect.forEach(
              rows,
              (row) =>
                Effect.map(
                  row.remote === undefined ? Effect.succeed(undefined) : repositoryIdentity(row.remote),
                  (id) => [row, id] as const,
                ),
              { concurrency: 8 },
            )
          : [],
      )

      const exactly = (w: Wanted) => (row: Checkout) => row.remote === w.repository
      const alike = (w: Wanted) => (row: Checkout) => w.identity !== undefined && identities.get(row) === w.identity
      const holds = (w: Wanted) => (row: Checkout) => exactly(w)(row) || alike(w)(row)
      const lacking = wanted.filter((w) => !rows.some(holds(w)))

      if (lacking.length > 0)
        return yield* new NoProject({
          message:
            input.repositories === undefined
              ? `${self.name} has no checkout of ${repositoriesNamed(lacking)}: clone it there and run vibest project add in it`
              : `${self.name} has no checkout of ${repositoriesNamed(lacking)}: clone ${lacking.length === 1 ? "it" : "them"} there beside the project's other repositories and run vibest project add in that folder`,
        })

      const pairedIn = (own: ReadonlyArray<Checkout>) => {
        const left = new Set(own)
        const taken = new Map<Wanted, Checkout>()

        const take = (w: Wanted, fits: (row: Checkout) => boolean) => {
          const row = own.find((r) => left.has(r) && fits(r))

          if (row === undefined) return
          left.delete(row)
          taken.set(w, row)
        }

        for (const w of wanted) take(w, exactly(w))

        for (const w of wanted) if (!taken.has(w)) take(w, alike(w))

        return wanted.every((w) => taken.has(w)) ? wanted.map((w) => ({ wanted: w, row: taken.get(w)! })) : undefined
      }

      const projects = [...new Set(rows.map((row) => row.id))].flatMap((id) => {
        const own = rows.filter((row) => row.id === id)
        const { directory } = own[0]!

        return directory === null ? [] : [{ id, directory, own }]
      })

      const shown = (list: ReadonlyArray<{ readonly id: string; readonly directory: string }>) =>
        list.map((p) => `${p.id} (${p.directory})`).join(", ")

      const holding = (list: typeof projects) =>
        list.flatMap((p) => {
          const pairs = p.own.length === wanted.length ? pairedIn(p.own) : undefined

          return pairs === undefined ? [] : [{ id: p.id, directory: p.directory, pairs }]
        })

      const { project: asked } = input

      const scope =
        asked === undefined
          ? projects
          : projects.filter(
              (p) =>
                p.id === asked ||
                (asked.length >= 8 && p.id.startsWith(asked)) ||
                p.directory.slice(p.directory.lastIndexOf("/") + 1) === asked,
            )

      if (asked !== undefined && scope.length !== 1)
        return yield* new NoProject({
          message:
            scope.length === 0
              ? `${self.name} has no project ${asked}; its projects: ${shown(projects)}`
              : `${asked} names several projects of ${self.name}: ${shown(scope)}`,
        })
      const legacy = input.repositories === undefined ? wanted[0] : undefined

      const candidates =
        legacy === undefined
          ? scope
          : scope.filter((p) =>
              p.own.some(scope.some((q) => q.own.some(exactly(legacy))) ? exactly(legacy) : alike(legacy)),
            )

      if (legacy !== undefined && candidates.length > 1)
        return yield* new NoProject({
          message: `${self.name} has several projects for ${legacy.repository}: ${shown(candidates)}; pass --project <id> to choose one`,
        })
      const found = holding(candidates)

      if (found.length === 0)
        return yield* new NoProject({
          message:
            asked !== undefined
              ? `${self.name}'s project ${shown(scope)} does not hold exactly ${repositoriesNamed(wanted)}`
              : legacy !== undefined && candidates.length === 1
                ? `${self.name} has no project whose repositories are exactly ${repositoriesNamed(wanted)}: its project ${shown(candidates)} holds other repositories too`
                : `${self.name} has no project whose repositories are exactly ${repositoriesNamed(wanted)}: add one there with vibest project add`,
        })

      if (found.length > 1)
        return yield* new NoProject({
          message: `${self.name} has several projects for ${repositoriesNamed(wanted)}: ${shown(found)}; pass --project <id> to choose one`,
        })
      const target = found[0]!

      const missing = (yield* Effect.forEach(target.pairs, (pair) =>
        Effect.map(git.hasCommit(pair.row.path, pair.wanted.commit), (has) => (has ? [] : [pair])),
      )).flat()

      if (missing.length > 0)
        return yield* new NoCommit({
          message: `${missing.map(({ wanted, row }) => `${self.name}'s checkout ${row.path} does not have ${wanted.commit}`).join("; ")}: push ${missing.length === 1 ? "it" : "them"} and fetch ${missing.length === 1 ? "it" : "them"} there`,
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
          ...(input.repositories === undefined && target.pairs[0]!.row.path === target.directory
            ? { commit: target.pairs[0]!.wanted.commit }
            : { folders: target.pairs.map(pinned) }),
          origin: { peer, project, reportTo },
          files: input.files,
        })
        .pipe(
          Effect.catchTag("NoRuntime", (e) => new NoRuntime({ message: `${self.name}: ${e.message}` })),
          Effect.catchTag("LinkRefused", Effect.die),
          Effect.catchTag("AmbiguousSession", Effect.die),
        )

      return {
        session: spawned.id,
        harness: spawned.harness,
        ...(spawned.provider !== undefined && { provider: spawned.provider }),
        ...(spawned.model !== undefined && { model: spawned.model }),
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
            db.remote.outboxOf(peer, cursor, OUTBOX_PAGE).pipe(
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

    ack: Effect.fn("Peer.ack")((peer: string, ids: ReadonlyArray<string>) => db.remote.ackOutbox(peer, ids)),
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
