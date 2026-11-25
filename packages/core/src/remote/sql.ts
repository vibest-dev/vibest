import { type AgentFrom } from "@vibest/schema/event"
import { randomId } from "@vibest/schema/id"
import { MachineEvent } from "@vibest/schema/machine-event"
import { Effect } from "effect"
import { SqlClient, type Statement } from "effect/sql"

import { Bus } from "../bus.ts"
import { type FromSql, fromOf } from "../database/rows.ts"

export type RemoteScope = { readonly remote: string; readonly project: string; readonly session?: string }

export type MachineRow = {
  readonly name: string
  readonly target: string
  readonly remoteId: string
  readonly connectedAt: number
  readonly createdAt: number
}

export type RemoteStart = {
  readonly remote: string
  readonly project: string
  readonly reportTo?: string | undefined
}

export type OutboxRow = {
  readonly id: string
  readonly seq: number
  readonly sessionId: string
  readonly content: string
  readonly kind: "send" | "notice"
  readonly from: AgentFrom | null
  readonly createdAt: number
  readonly reportTo: string
}

export const remoteSql = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const { publish } = yield* Bus.Service

  const ofRemote = (session: Statement.Fragment, scope: RemoteScope) =>
    scope.session === undefined
      ? sql`EXISTS (SELECT 1 FROM session o WHERE o.id = ${session} AND o.origin_remote = ${scope.remote}
          AND o.origin_project = ${scope.project})`
      : sql`EXISTS (WITH RECURSIVE line(id) AS (
          SELECT ${session} UNION SELECT a.parent_session_id FROM session a JOIN line ON a.id = line.id
            WHERE a.parent_session_id IS NOT NULL)
        SELECT 1 FROM session o WHERE o.id IN (SELECT id FROM line) AND o.origin_remote = ${scope.remote}
          AND o.origin_project = ${scope.project} AND o.origin_session = ${scope.session})`

  const origins = (sessionId: string) =>
    sql<{
      remote: string | null
      project: string | null
      session: string | null
    }>`SELECT origin_remote AS remote, origin_project AS project, origin_session AS session
      FROM session WHERE id = ${sessionId}`.pipe(Effect.map((rows) => rows[0]))

  const queueForRemote = (
    remote: string,
    recipientSession: string | null,
    row: {
      readonly sessionId: string
      readonly content: string
      readonly kind: "send" | "notice"
      readonly from?: AgentFrom | undefined
      readonly at?: number
      readonly request?: string | undefined
      readonly id?: string | undefined
    },
  ) =>
    Effect.gen(function* () {
      if (recipientSession === null) return false

      let viaRemote = remote
      let recipient = recipientSession

      if ((yield* sql`SELECT 1 FROM remote WHERE id = ${remote}`).length === 0) {
        const origin = yield* origins(row.sessionId)

        if (!origin?.remote || (yield* sql`SELECT 1 FROM remote WHERE id = ${origin.remote}`).length === 0) return false
        viaRemote = origin.remote
        recipient = `${remote}:${recipientSession}`
      }

      const id = row.id ?? row.request ?? randomId()

      if ((yield* sql`SELECT 1 FROM outbox WHERE id = ${id}`).length > 0) return true

      const [open] =
        row.kind === "send"
          ? yield* sql<{ id: number }>`SELECT id FROM execution WHERE session_id = ${row.sessionId} AND owner = 1`
          : []

      yield* publish(
        MachineEvent.OutboxQueued,
        {
          id,
          remoteId: viaRemote,
          session: row.sessionId,
          recipient,
          kind: row.kind,
          content: row.content,
          ...(row.from !== undefined && { from: row.from }),
          ...(open !== undefined && { execution: open.id }),
        },
        row.at === undefined ? undefined : { at: row.at },
      )

      return true
    })

  const senderOf = (sessionId: string) =>
    sql<{ agent: string; name: string }>`SELECT agent, name FROM session WHERE id = ${sessionId}`.pipe(
      Effect.map(([row]): AgentFrom | undefined => row && { session: sessionId, agent: row.agent, title: row.name }),
    )

  const remoteName = (id: string) =>
    sql<{ name: string }>`SELECT name FROM machine WHERE remote_id = ${id}
      UNION ALL SELECT name FROM remote WHERE id = ${id}`.pipe(Effect.map((rows) => rows[0]?.name))

  const outboxOf = (remote: string, after: number, limit: number) =>
    sql<Omit<OutboxRow, "from"> & FromSql>`SELECT o.id, o.seq, o.session_id, o.kind, o.content,
        o.from_session, o.from_agent, o.from_title, o.from_machine, o.created_at,
        coalesce(o.recipient, s.origin_session) AS report_to
      FROM outbox o LEFT JOIN session s ON s.id = o.session_id
      WHERE o.remote_id = ${remote} AND o.acked_at IS NULL AND o.seq > ${after}
        AND coalesce(o.recipient, s.origin_session) IS NOT NULL
      ORDER BY o.seq LIMIT ${limit}`.pipe(
      Effect.map((rows) =>
        rows.map(({ fromSession, fromAgent, fromTitle, fromMachine, ...row }): OutboxRow => ({
          ...row,
          from: fromOf({ fromSession, fromAgent, fromTitle, fromMachine }),
        })),
      ),
    )

  const hasRemoteItem = (item: string) =>
    sql`SELECT 1 FROM inbox WHERE transfer_id = ${item}`.pipe(Effect.map((rows) => rows.length > 0))

  const machines = sql<MachineRow>`SELECT name, target, remote_id, connected_at, created_at FROM machine ORDER BY name`

  return { ofRemote, origins, queueForRemote, senderOf, remoteName, outboxOf, hasRemoteItem, machines }
})

export type RemoteSql = Effect.Success<typeof remoteSql>
