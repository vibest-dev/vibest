import { type AgentFrom } from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { MachineEvent } from "@vibest/schema/machine-event"
import { LayerNode } from "@vibest/util/layer-node"
import { Context, Effect, Layer } from "effect"

import { Bus } from "../bus.ts"
import { Database } from "../database/database.ts"
import { PlatformNode } from "../effect/platform.ts"
import { inboxSql } from "../inbox/sql.ts"
import { Projectors } from "../reactor.ts"
import { SessionLive } from "../session/live.ts"
import { noticeEnvelope, sessionEnvelope } from "../session/replies.ts"
import { queryRemoteEdges } from "../session/sql-edges.ts"
import { sessionSql } from "../session/sql.ts"
import { remoteSql, type MachineRow } from "./sql.ts"

export * as RemoteStore from "./store.ts"

export type { MachineRow, OutboxRow, RemoteScope, RemoteStart } from "./sql.ts"

export const make = Effect.gen(function* () {
  const { sql } = yield* Database.Service
  const { publish, transaction: tx } = yield* Bus.Service
  const session = yield* sessionSql
  const remote = yield* remoteSql
  const inbox = yield* inboxSql(session, remote)
  const { queueForRemote } = remote
  const machineColumns = sql`name, target, remote_id, connected_at, created_at`

  const machineNamed = (name: string) =>
    sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE name = ${name}`.pipe(Effect.map((rows) => rows[0]))

  return {
    machines: remote.machines.pipe(Effect.orDie),

    machineNamed: Effect.fn("RemoteStore.machineNamed")((name: string) => machineNamed(name).pipe(Effect.orDie)),

    machineWithRemote: Effect.fn("RemoteStore.machineWithRemote")((id: string) =>
      sql<MachineRow>`SELECT ${machineColumns} FROM machine WHERE remote_id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
        Effect.orDie,
      ),
    ),

    addMachine: Effect.fn("RemoteStore.addMachine")(
      (row: { readonly name: string; readonly target: string; readonly remoteId: string }) =>
        tx(
          Effect.gen(function* () {
            const taken = yield* sql`SELECT 1 FROM machine WHERE name = ${row.name} OR remote_id = ${row.remoteId}`

            if (taken.length > 0) return undefined
            yield* publish(MachineEvent.Added, { name: row.name, target: row.target, remote: row.remoteId })

            return yield* machineNamed(row.name)
          }),
        ).pipe(Effect.orDie),
    ),

    removeMachine: Effect.fn("RemoteStore.removeMachine")((name: string) =>
      tx(
        Effect.gen(function* () {
          if ((yield* machineNamed(name)) === undefined) return false
          yield* publish(MachineEvent.Removed, { name })

          return true
        }),
      ).pipe(Effect.orDie),
    ),

    machineConnected: Effect.fn("RemoteStore.machineConnected")((name: string) =>
      tx(
        Effect.gen(function* () {
          if ((yield* machineNamed(name)) !== undefined) yield* publish(MachineEvent.Connected, { name })
        }),
      ).pipe(Effect.orDie),
    ),

    receiveRemoteItem: Effect.fn("RemoteStore.receiveRemoteItem")(
      (item: {
        readonly id: string
        readonly recipient: string
        readonly kind: "send" | "notice"
        readonly sender: string
        readonly from: AgentFrom
        readonly content: string
      }): Effect.Effect<"unknown" | "duplicate" | "queued"> =>
        tx(
          Effect.gen(function* () {
            const [route] = yield* sql<{ alive: number }>`SELECT s.ended_at IS NULL AS alive
              FROM session s WHERE s.id = ${item.recipient}`

            if (route === undefined) return "unknown" as const

            if (yield* remote.hasRemoteItem(item.id)) return "duplicate" as const

            const [forwarded] = yield* sql<{ session: string }>`SELECT session_id AS session FROM outbox
              WHERE id = ${item.id}`

            if (forwarded !== undefined && forwarded.session === item.recipient) return "duplicate" as const

            const heir = route.alive === 1 ? { local: item.recipient } : yield* session.nearestAlive(item.recipient)

            const noticeSender = item.from.machine ? `${item.sender} (on ${item.from.machine})` : item.sender

            const content =
              item.kind === "send"
                ? sessionEnvelope(item.from.session, item.content, item.from.machine)
                : noticeEnvelope(`${noticeSender}: ${item.content}`)

            if (heir !== undefined && "remote" in heir) {
              const [leg] = yield* sql<{
                session: string
              }>`SELECT session_id AS session FROM outbox WHERE id = ${item.id}`

              if (leg !== undefined && leg.session === item.recipient) return "duplicate" as const

              const id = leg === undefined ? item.id : randomId()

              const queued = yield* queueForRemote(heir.remote, heir.session, {
                id,
                sessionId: item.recipient,
                kind: item.kind,
                ...(item.kind === "send" && { from: item.from }),
                content: item.kind === "send" ? item.content : `${noticeSender}: ${item.content}`,
              })

              if (!queued) return "unknown" as const

              if (id !== item.id) {
                const receipt = yield* inbox.queueInbox({
                  recipient: item.recipient,
                  sender: item.kind === "send" ? { type: "agent", ...item.from } : { type: "vibest" },
                  content,
                  transfer: item.id,
                })

                yield* inbox.moveInbox(sql`recipient_session_id = ${item.recipient} AND id = ${receipt}`, "dropped", {
                  reason: "forwarded",
                })
              }

              return "queued" as const
            }

            const target = heir !== undefined && "local" in heir ? heir.local : undefined

            if (target === undefined) {
              const queued = yield* inbox.queueInbox({
                recipient: item.recipient,
                sender: item.kind === "send" ? { type: "agent", ...item.from } : { type: "vibest" },
                content,
                transfer: item.id,
              })

              yield* inbox.moveInbox(sql`recipient_session_id = ${item.recipient} AND id = ${queued}`, "dropped", {
                reason: "the session was archived",
              })

              return "queued" as const
            }

            yield* inbox.queueInbox({
              recipient: target,
              sender: item.kind === "send" ? { type: "agent", ...item.from } : { type: "vibest" },
              content,
              transfer: item.id,
            })

            return "queued" as const
          }),
        ).pipe(Effect.orDie),
    ),

    projectCheckouts: sql<{ id: string; directory: string | null; path: string }>`SELECT p.id, p.directory, r.path
        FROM project p JOIN project_repository r ON r.project_id = p.id ORDER BY p.rowid, r.rowid`.pipe(Effect.orDie),

    outboxOf: Effect.fn("RemoteStore.outboxOf")((remoteId: string, after = 0, limit = -1) =>
      remote.outboxOf(remoteId, after, limit).pipe(Effect.orDie),
    ),

    ackOutbox: Effect.fn("RemoteStore.ackOutbox")((remoteId: string, ids: ReadonlyArray<string>) =>
      (ids.length === 0
        ? Effect.void
        : tx(
            Effect.gen(function* () {
              const found = yield* sql<{ id: string }>`SELECT id FROM outbox WHERE remote_id = ${remoteId}
                AND acked_at IS NULL AND ${sql.in("id", ids)} ORDER BY seq`

              const [first, ...rest] = found.map((row) => row.id)

              if (first !== undefined) yield* publish(MachineEvent.OutboxAcked, { remoteId, ids: [first, ...rest] })
            }),
          )
      ).pipe(Effect.orDie),
    ),

    noteRemote: Effect.fn("RemoteStore.noteRemote")((row: { readonly id: string; readonly name: string }) =>
      tx(
        Effect.gen(function* () {
          const rows = yield* sql<{ name: string }>`SELECT name FROM remote WHERE id = ${row.id}`

          if (rows[0]?.name === row.name) return
          yield* publish(MachineEvent.RemoteSeen, { remoteId: row.id, name: row.name })
        }),
      ).pipe(Effect.orDie),
    ),

    senderOf: Effect.fn("RemoteStore.senderOf")((sessionId: string) => remote.senderOf(sessionId).pipe(Effect.orDie)),

    nameForRemote: Effect.fn("RemoteStore.nameForRemote")((id: string) => remote.remoteName(id).pipe(Effect.orDie)),

    remoteKnown: Effect.fn("RemoteStore.remoteKnown")((id: string) =>
      sql`SELECT 1 FROM remote WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orDie,
      ),
    ),

    sendToLinkedRemote: Effect.fn("RemoteStore.sendToLinkedRemote")(
      (sessionId: string, target: string, message: string, request?: string) =>
        tx(
          Effect.gen(function* () {
            const matches = yield* queryRemoteEdges(sql, sessionId, target)

            if (matches.length === 0) return undefined

            if (matches.length > 1) return { ambiguous: matches.map((m) => m.session) } as const
            const [match] = matches

            const queued = yield* queueForRemote(match!.remote, match!.session, {
              sessionId,
              kind: "send",
              content: message,
              request,
              from: yield* remote.senderOf(sessionId),
            })

            return queued ? ({ sent: match!.session } as const) : ("unknown" as const)
          }),
        ).pipe(Effect.orDie),
    ),

    sendToRemote: Effect.fn("RemoteStore.sendToRemote")(
      (sender: string, remoteId: string, recipient: string, message: string, request?: string) =>
        tx(
          Effect.gen(function* () {
            return yield* queueForRemote(remoteId, recipient, {
              sessionId: sender,
              kind: "send",
              content: message,
              request,
              from: yield* remote.senderOf(sender),
            })
          }),
        ).pipe(Effect.orDie),
    ),
  }
})

export type Interface = Effect.Success<typeof make>

export class Service extends Context.Service<Service, Interface>()("vibest/RemoteStore") {}

export const layer = Layer.effect(Service, make)

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [Database.node, Bus.node, Projectors.node, SessionLive.node, PlatformNode.sqlClient],
})
