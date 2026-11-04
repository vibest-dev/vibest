import { MessageStatus } from "@vibest/schema/model"
import {
  RuntimeAddress,
  type InboxKind,
  type InboxRow,
  type InboxStatus,
  AgentStatus,
  TurnState,
} from "@vibest/schema/session"
// The engine's storage port: the operations on sessions, inbox rows and events the engine needs, each with its
// contract (docs/architecture.md, Storage). The engine holds no SQL and no schema; a product implements the port (vibest:
// @vibest/vibest/sqlite-store, its SQLite file) and passes the shared contract suite.
//
// The session row callers read (`SessionRow`) is a read model: its process, turn and live fields come from the
// append-only events, and every change to them appends an event.
import { Context, type Effect, Schema } from "effect"

import type { HarnessId } from "./harness.ts"
import { Routing } from "./plugins.ts"
export { RuntimeAddress, InboxKind, InboxRow, InboxStatus, AgentStatus, TurnState } from "@vibest/schema/session"

export const AddressJson = Schema.fromJsonString(RuntimeAddress)
export const encodeAddress = Schema.encodeSync(AddressJson)

/** What a running agent reports and a restart needs; on every session row, the main agent's too. */
const Live = {
  /** The integration (harness plugin) version and protocol the agent last sent (vibest-plugin-version, vibest-protocol). */
  integration: Schema.optional(Schema.Struct({ version: Schema.String, protocol: Schema.Number })),
  /** The harness's own process, as its integration reported it when ready: the pid a restart sends SIGTERM to. */
  pid: Schema.optional(Schema.Number),
  /** When the harness's integration reported it takes input; none since its process started. */
  ready: Schema.optional(Schema.Number),
}

const Metadata = Schema.Struct({
  ...Live,
  routing: Schema.optional(Routing),
  /** `vibest run --archive-on-completion`: asked for; a plugin acts on it (plugin-coordinator archives once a completed result was delivered). */
  archive: Schema.optional(Schema.Boolean),
  /** `vibest archive` (alias `rm`) ran (`session.ended_at`): never resumed again, even when its worktree was kept. */
  archived: Schema.optional(Schema.Boolean),
  /** Same as `archived`, for older readers. */
  removed: Schema.optional(Schema.Boolean),
  /**
   * Real usage-limit tries for this session, oldest first: the (harness, provider) pairs whose process ended on a
   * limit (`process.end` reason `limited`). Skips inside one move are not kept.
   */
  attempts: Schema.optional(
    Schema.Array(
      Schema.Struct({
        harness: Schema.String,
        provider: Schema.optional(Schema.String),
        outcome: Schema.Literal("limited"),
        at: Schema.Number,
      }),
    ),
  ),
})
/** A session in the shape its callers read: its columns plus what its events say. */
export const SessionRow = Schema.Struct({
  id: Schema.String,
  /** The grouping the product gave the session (vibest: its project's key). The engine only compares it. */
  scope: Schema.String,
  agent: Schema.String,
  harnessId: Schema.String,
  harnessSessionId: Schema.NullOr(Schema.String),
  runtime: Schema.String,
  address: AddressJson,
  name: Schema.String,
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  /** The runtime's status of the agent, last seen; `unknown` before the runtime reported it. Memory only. */
  status: AgentStatus,
  /** When its agent last started (spawn or resume); null while the first start is under way. */
  startedAt: Schema.NullOr(Schema.Number),
  /** When its agent process was seen gone (or never came up); cleared when it starts again. */
  exitedAt: Schema.NullOr(Schema.Number),
  turnState: TurnState,
  turnPromptedAt: Schema.Number,
  metadata: Schema.fromJsonString(Metadata),
  createdAt: Schema.Number,
  lastActive: Schema.Number,
})
export type SessionRow = typeof SessionRow.Type

/** Why a process ended (`process.end` reason). */
export type EndReason = "exited" | "limited" | "restart" | "move" | "archived" | "launch_failed"

export type SessionPatch = Partial<Omit<SessionRow, "id" | "scope" | "agent" | "createdAt" | "runtime">> & {
  /** With `exitedAt`: why its process ended. Default `exited`. */
  readonly end?: EndReason
}

/**
 * A scope's owner: the one session the product makes answerable for its scope (vibest: the project's main agent). It
 * gets the scope's rows that have no other session to go to, and whole-scope rights (capabilities `GroupOwner`). It is
 * not listed among the scope's sessions.
 */
export const OwnerRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  harnessId: Schema.String,
  harnessSessionId: Schema.NullOr(Schema.String),
  /** Where it runs; null while it has no place (its process ended, or it is moving: `detachOwner`). */
  runtime: Schema.NullOr(Schema.String),
  address: Schema.NullOr(AddressJson),
  /** The directory it works in, written at its first start. Absent when none was given. */
  directory: Schema.optional(Schema.String),
  createdAt: Schema.Number,
  /** What scheduling chose when it last started: provider, model, routing. */
  provider: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
  routing: Schema.optional(Routing),
  ...Live,
})
export type OwnerRow = typeof OwnerRow.Type

export type NewInboxRow = Omit<InboxRow, "id" | "status" | "createdAt">

export const ROUND_STATUS = ["completed", "failed", "interrupted", "lost", "not_started"] as const

/** `turn.end` data (schema.md), written once. */
export type TurnEnd = {
  readonly status: (typeof ROUND_STATUS)[number]
  /** The harness's last answer text. */
  readonly output?: string
  /** The harness's error. */
  readonly failure?: { readonly message: string }
}

/** A harness error as `turn.end` failure; none for an empty error. */
export const failureOf = (error: string | undefined): TurnEnd["failure"] =>
  error === undefined || error === "" ? undefined : { message: error }

export type MessageStatusName = typeof MessageStatus.Type

export type SessionBrief = {
  readonly task: string | null
  readonly latest: {
    readonly status: MessageStatusName
    readonly summary: string
    readonly endedAt: number | null
  } | null
}

/** The integration (harness plugin) version and protocol an agent sent. */
export type Integration = { readonly version: string; readonly protocol: number }

/** A place in a runtime: its kind and the terminal's address. */
export type Place = { readonly runtime: string; readonly address: RuntimeAddress }

/**
 * The storage port. Every operation is atomic: it sees and leaves a consistent state, and two operations never
 * interleave their changes. Events are append-only and ordered by id; every session read is derived from them, so a
 * write is an event append plus the few session columns (name, directory, ended). Unknown ids read as absent and
 * write nothing. Times are milliseconds from the engine's Clock.
 */
export interface DbShape {
  // Sessions.

  /**
   * Insert session `row` in `scope`, working in `cwd`, with `task` as its first inbox row (delivered, or pending for a
   * polling integration with `taskPending`), and the process and turn `row` describes, unless `max` live non-owner
   * sessions already run. All or nothing; false when refused. Its results go to `reportToSessionId`, else its parent,
   * else the scope's owner.
   */
  readonly insertSession: (
    row: Omit<SessionRow, "scope">,
    scope: string,
    max?: number,
    cwd?: string,
    task?: string,
    parentSessionId?: string,
    reportToSessionId?: string,
    taskPending?: boolean,
  ) => Effect.Effect<boolean>
  readonly sessionExists: (id: string) => Effect.Effect<boolean>
  /** Any session, the owner's too: its scope, definition, current harness, and whether it owns its scope. */
  readonly sessionIdentity: (
    id: string,
  ) => Effect.Effect<{ id: string; scope: string; agent: string; harness: string; owner: boolean } | undefined>
  /** A non-owner session, or an owner a fresh start replaced (`startOwner` with `fresh`). */
  readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
  /** Live non-owner sessions (`scope`: of one scope), oldest first; `stopped` adds ended ones and replaced owners. */
  readonly listSessions: (filter?: { scope?: string; stopped?: boolean }) => Effect.Effect<ReadonlyArray<SessionRow>>
  /**
   * Apply `patch`: a new harness choice or an opened terminal appends a `process.start`, a new conversation a
   * `process.conversation`, `exitedAt` a `process.end` (`end`, default exited), `turnState` open a `turn.start` (on an
   * open turn only its hand-over time moves) and an end state a `turn.end`; `archived` ends the session for good.
   * The runtime status is kept in memory only.
   */
  readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
  /** Task text and latest turn per id; unknown ids are absent. */
  readonly sessionBriefs: (ids: ReadonlyArray<string>) => Effect.Effect<Map<string, SessionBrief>>
  /** Whether `ancestor` started `id`, or started a session that did. */
  readonly descends: (id: string, ancestor: string) => Effect.Effect<boolean>
  readonly parentOf: (id: string) => Effect.Effect<string | undefined>
  /** The directory the session works in, as recorded at insert (`cwd`). */
  readonly sessionDirectory: (id: string) => Effect.Effect<string | undefined>
  /** The other live sessions that work in `id`'s (non-empty) directory on its machine, by id. */
  readonly liveSharers: (id: string) => Effect.Effect<string[]>
  /** The earliest live session created before `id` that shares its directory (the one `id` joined), if any. */
  readonly earlierSharer: (id: string) => Effect.Effect<string | undefined>
  /** The scope of session `id`. */
  readonly scopeOf: (id: string) => Effect.Effect<string | undefined>
  /** How many sessions have a live status in memory (it shrinks back once sessions end). */
  readonly liveStatuses: Effect.Effect<number>

  // Owners.

  readonly owners: Effect.Effect<ReadonlyArray<OwnerRow>>
  readonly ownerOf: (scope: string) => Effect.Effect<OwnerRow | undefined>
  /** The scope whose owner runs at `place` (not moving), if any. */
  readonly ownerAt: (runtime: string, address: RuntimeAddress) => Effect.Effect<string | undefined>
  /**
   * Start `scope`'s owner at `location`, creating it on first use; its id is stable across starts and harness
   * switches. `fresh` ends the current owner (it stays readable with `getSession`) and makes another. The same
   * harness continues its conversation unless `fresh`. An owner of another scope at that place loses it, and that
   * scope's owner-bound pending rows drop; this scope's drop too unless it was moving here (`detachOwner`).
   */
  readonly startOwner: (
    scope: string,
    harness: HarnessId,
    fresh: boolean,
    location: Place,
    start?: {
      readonly provider?: string | undefined
      readonly model?: string | undefined
      readonly routing?: unknown
      /** Its directory, kept from its first start on. */
      readonly directory?: string | undefined
      /** The PID its harness will have, before its integration reports one. */
      readonly pid?: number | undefined
    },
  ) => Effect.Effect<{ sessionId: string; harnessSessionId: string | null }>
  /** The owner's harness reported its conversation; another harness, or a session that owns nothing, changes nothing. */
  readonly reportOwnerConversation: (
    sessionId: string,
    harness: HarnessId,
    harnessSessionId: string,
  ) => Effect.Effect<void>
  /**
   * The owner leaves `place` to move: no place while it moves (`clearOwnerAt` no longer matches it), and its pending
   * rows wait for the next `startOwner`. False when it is not at that place. Memory only.
   */
  readonly detachOwner: (scope: string, runtime: string, address: RuntimeAddress) => Effect.Effect<boolean>
  /** Undo `detachOwner`. */
  readonly reattachOwner: (scope: string, runtime: string, address: RuntimeAddress) => Effect.Effect<void>
  /** The owner at `place` is gone: its process ends and its pending owner-bound rows drop. */
  readonly clearOwnerAt: (runtime: string, address: RuntimeAddress) => Effect.Effect<void>

  // Processes.

  /** The harness's conversation id; written only when it changed, true then. */
  readonly noteHarnessSession: (id: string, harnessSessionId: string) => Effect.Effect<boolean>
  /** The integration a session's requests carry (memory until its next ready report); true when it changed. */
  readonly noteIntegration: (id: string, integration: Integration) => Effect.Effect<boolean>
  /** A ready report (`ready`, with the integration last noted) or a pid alone: a `process.ready`. Nulls change nothing. */
  readonly patchLive: (
    id: string,
    patch: { readonly pid?: number | null; readonly ready?: number | null },
  ) => Effect.Effect<void>
  /** When the current process last reported ready; undefined when it has not. */
  readonly readyAt: (id: string) => Effect.Effect<number | undefined>
  /** End the current process (`restart`) and start the same one again on its conversation; an open turn stays open. */
  readonly restartProcess: (id: string) => Effect.Effect<void>
  /** End the current process with `reason`; false when it had already ended (one `process.end` per process). */
  readonly endProcess: (id: string, reason: EndReason) => Effect.Effect<boolean>

  // Turns.

  /** Close the open turn with an end state, with `patch`. */
  readonly closeTurn: (id: string, end: TurnState, patch: SessionPatch) => Effect.Effect<void>
  /** Open a user-typed turn with `patch`; false when one is already open. */
  readonly beginUserTurn: (id: string, text: string, patch: SessionPatch) => Effect.Effect<boolean>
  /**
   * Close the open turn with `end` (one `turn.end` per turn; with none open, one is opened and closed) and insert
   * `row` (a result points at that `turn.end`) to `to`, with `patch`, all at once. `at`: the end is stamped no earlier.
   */
  readonly finishTurn: (
    id: string,
    end: TurnEnd,
    patch: SessionPatch,
    row: NewInboxRow,
    at?: number,
    to?: ReadonlyArray<string | null>,
  ) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** Whether the open turn was taken up: typed, or a row was delivered into it. False with none open. */
  readonly turnTaken: (id: string) => Effect.Effect<boolean>
  /** The latest time on any turn start or end; undefined with no turn. */
  readonly latestRoundAt: (sessionId: string) => Effect.Effect<number | undefined>
  /**
   * What a move can resend: the open turn's input (`working`: its typed text, or the rows it consumed), else the
   * trailing run of delivered tasks and sends from one sender no turn consumed (`delivered`), and the parent.
   */
  readonly rescheduleSource: (
    id: string,
  ) => Effect.Effect<{ working: string; delivered: string; parentSessionId: string | undefined }>
  /**
   * Who the open turn's result goes to (`null`: the user; none: nobody): the senders of the tasks and sends it
   * consumed, else its report-to, else the user when it consumed the user's own; an ended recipient is replaced by
   * the scope's owner (never `id`), else the user.
   */
  readonly replyTo: (id: string) => Effect.Effect<ReadonlyArray<string | null>>

  // Inbox.

  /**
   * Insert `row`, one per recipient (`to`, else `noticeTo`; a send goes to its session, a result to `replyTo` and
   * closes the open turn). A row to the scope's owner while it has no place is dropped; with no recipient at all one
   * row is kept, dropped, as the sender's own. Each insert appends `inbox.queued`.
   */
  readonly insertInbox: (row: NewInboxRow, to?: ReadonlyArray<string | null>) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** Where a notice about `id` goes by default: its live report-to, else the scope's owner, else the user. */
  readonly noticeTo: (id: string) => Effect.Effect<(string | null)[]>
  /** A send to the session from `from` (none: the user), unless it is archived. Atomic with `archiveIfNoPending`. */
  readonly insertSend: (sessionId: string, message: string, from?: string) => Effect.Effect<InboxRow | undefined>
  /** Archive the session unless a send to it is pending; false then. */
  readonly archiveIfNoPending: (id: string) => Effect.Effect<boolean>
  /** What the session takes itself: its pending sends and tasks, and other rows to it unless it owns its scope. */
  readonly pendingInbox: (sessionId: string) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** Which of `ids` are addressed to `sessionId` and not yet delivered (pending or sending). */
  readonly ownInbox: (sessionId: string, ids: ReadonlyArray<number>) => Effect.Effect<readonly number[]>
  /** The sends to the session in `status`. */
  readonly inboxWithStatus: (sessionId: string, status: InboxStatus) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** The pending rows to the user from `scope`'s sessions, oldest first; `read` marks them delivered. */
  readonly userInbox: (scope: string, read: boolean) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** The pending rows to `scope`'s owner (not sends or tasks), oldest first. */
  readonly ownerPending: (scope: string) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** Scopes with owner-bound rows pending. */
  readonly pendingScopes: Effect.Effect<string[]>
  /** The owner's lease on `ids` ended: those still sending go back to pending. Returns them. */
  readonly releaseLeased: (scope: string, ids: ReadonlyArray<number>) => Effect.Effect<readonly number[]>
  /** The owner took `ids` (delivered) and gave back `release` (pending): only its own rows. Returns the delivered rows. */
  readonly settleLeased: (
    scope: string,
    ids: ReadonlyArray<number>,
    release: ReadonlyArray<number>,
  ) => Effect.Effect<ReadonlyArray<InboxRow>>
  /**
   * After a restart: owner-bound rows left sending go back to pending when the owner's harness polls
   * (`pollHarnesses`), else fail. Session-bound sending rows stay.
   */
  readonly recoverSending: (pollHarnesses: ReadonlyArray<string>) => Effect.Effect<void>
  /** Every row sending. */
  readonly sendingInbox: Effect.Effect<{ id: number; sessionId: string; kind: InboxKind }[]>
  /**
   * Drop `scope`'s pending owner-bound rows; with a guard only while its owner is still at that place, or (`absent`)
   * still has none and is not moving.
   */
  readonly dropWaiting: (
    scope: string,
    guard?: { readonly runtime: string; readonly address: string } | "absent",
  ) => Effect.Effect<void>
  /**
   * Claim pending rows (sending): exclusive, each id is returned to one caller only. With a guard, only while the
   * scope's owner is at that place (and runs `harnessId`).
   */
  readonly claim: (
    ids: ReadonlyArray<number>,
    guard?: { readonly scope: string; readonly runtime: string; readonly address: string; readonly harnessId?: string },
  ) => Effect.Effect<readonly number[]>
  /** Move rows (only those in `from`, when given) to `status`; returns the rows changed. A delivered row names the open turn it went into. */
  readonly setInboxStatus: (
    ids: ReadonlyArray<number>,
    status: InboxStatus,
    from?: InboxStatus,
  ) => Effect.Effect<ReadonlyArray<InboxRow>>
  /** The newest row of `kind` for the session (a send to it, else one it sent), whatever its status. */
  readonly latestInbox: (sessionId: string, kind: InboxKind) => Effect.Effect<InboxRow | undefined>
}

export class Db extends Context.Service<Db, DbShape>()("vibest/Db") {}
