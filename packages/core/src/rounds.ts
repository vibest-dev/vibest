import { NoSuchSession, NotReady } from "@vibest/schema/session"
// The round lifecycle of one session: ending a turn, delivering its queued messages, collecting a hook-written
// result, and recording a user-typed round (SPEC §8.3, §8.4, §11). Everything here runs under the session's lock,
// held by `check`, `deliver`, `interrupt` or `remove` in sessions.ts — except `userPrompt`, which stamps the round at
// hook receipt and takes the lock only to record it. The terminal the row addresses is what everything here talks to
// (runtime-port.md §3).
import { Clock, Effect, Exit, Option, Ref } from "effect"
import type { FileSystem } from "effect"

import {
  type InboxRow,
  type InboxStatus,
  type NewInboxRow,
  type SessionPatch,
  type SessionRow,
  type TurnEnd,
  type TurnState,
  failureOf,
} from "./db.ts"
import { Harnesses } from "./harness.ts"
import { nextBatch } from "./inbox.ts"
import type { LimitMove } from "./move.ts"
import { workspaceGit } from "./project-create.ts"
import { envelope, isUsageLimitError, outcome, parseReport, readResult, type ResultStatus } from "./results.ts"
import { type Runtime, type RuntimeError, type Terminal } from "./runtimes.ts"
import { gitState } from "./worktree.ts"

export const sessionRounds = (deps: {
  readonly db: {
    readonly finishTurn: (
      id: string,
      end: TurnEnd,
      patch: SessionPatch,
      row: NewInboxRow,
      at?: number,
      to?: ReadonlyArray<string | null>,
    ) => Effect.Effect<InboxRow>
    readonly pendingInbox: (sessionId: string) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly claim: (ids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<number>>
    readonly setInboxStatus: (
      ids: ReadonlyArray<number>,
      status: InboxStatus,
      from?: InboxStatus,
    ) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly latestRoundAt: (sessionId: string) => Effect.Effect<number | undefined>
    readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
    readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
    readonly beginUserTurn: (id: string, text: string, patch: SessionPatch) => Effect.Effect<boolean>
  }
  readonly inbox: { readonly announce: (row: InboxRow) => Effect.Effect<void> }
  readonly layout: { readonly resultFile: (id: string) => string; readonly reportFile: (id: string) => string }
  readonly harnesses: Harnesses["Service"]
  /** The session's in-memory state: the flag set while vibest itself pastes a prompt. */
  readonly track: (id: string) => Effect.Effect<{ readonly prompting: Ref.Ref<boolean> }>
  /** The session's lock alone, not counted by Drain (a typed prompt records its round). */
  readonly lock: (id: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly undelivered: (
    session: SessionRow,
    rows: ReadonlyArray<{ readonly id: number; readonly message: string }>,
    reason: string,
  ) => Effect.Effect<unknown>
  readonly logged: (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void | A, never, R>
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover?: Effect.Effect<void>,
    options?: { readonly keepRound?: boolean },
  ) => Effect.Effect<string | undefined, NotReady | RuntimeError, FileSystem.FileSystem>
  /** Where a finished turn's result goes: reply routing, then the `agent.result` plugins. */
  readonly route: (
    session: SessionRow,
    status: "completed" | "failed" | "lost",
    output: string,
  ) => Effect.Effect<ReadonlyArray<string | null>>
  /** The usage-limit move (move.ts), wired in after the rounds exist. */
  readonly limitMove: Pick<LimitMove, "rerun">
}) => {
  const { db, inbox, layout, harnesses } = deps

  const finish = Effect.fn("Sessions.finish")(function* (
    session: SessionRow,
    end: Extract<TurnState, "completed" | "failed" | "lost">,
    text: string,
    error: string | undefined,
    /** A result file's time: the turn ends no earlier, so the same file is not taken again. */
    at?: number,
  ) {
    const report = parseReport(text)
    const status: ResultStatus = end === "completed" && !error ? "completed" : "failed"
    // A failed turn shows its error, so vibest ls says why.
    const summary =
      status === "failed" ? outcome(session.name, error) : (report.summary ?? outcome(session.name, error))
    const worktree = yield* deps.worktreeOf(session)
    const repos = yield* workspaceGit(worktree)
    const g = repos ? undefined : yield* gitState(worktree)
    const info = {
      id: session.id,
      // A session reports as the agent it runs.
      agent: session.agent,
      harness: session.harnessId,
      name: session.name,
      status,
      branch: repos ? repos.map((r) => `${r.name}=${r.branch}`).join("\n") : (g?.branch ?? ""),
      pushed: repos ? repos.map((r) => `${r.name}=${r.pushed}`).join("\n") : String(g?.pushed ?? false),
      worktree,
    }
    const body = [text, error ? `error: ${error}` : ""].filter(Boolean).join("\n\n")
    const message = envelope(
      "agent-result",
      [
        ["agent-id", session.id],
        ["status", info.status],
        ["summary", summary],
        ["harness", session.harnessId],
        ["branch", info.branch],
        ["pushed", repos ? info.pushed : info.branch ? info.pushed : ""],
        ["worktree", worktree],
      ],
      ["result", body],
    )
    const failure = failureOf(error)
    const to = yield* deps.route(session, end, text)
    const row = yield* db.finishTurn(
      session.id,
      { status: end, output: text, ...(failure === undefined ? {} : { failure }) },
      { turnState: end, lastActive: yield* Clock.currentTimeMillis },
      {
        sessionId: session.id,
        kind: "result",
        message,
        details: { ...info, summary, remember: report.remember, error },
      },
      at,
      to,
    )
    yield* inbox.announce(row)
  })

  /**
   * Queued messages for an idle session: one wake = one delivery, consecutive rows from one sender merged (SPEC §11.1, §11.4).
   * The batch goes pending → sending (handed to the runtime) → delivered, or failed with the owner told; only its own rows.
   */
  const deliverQueued = Effect.fn("Sessions.deliverQueued")(function* (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
  ) {
    const pending = yield* db.pendingInbox(session.id)
    if (pending.length === 0) return
    const batch = nextBatch(pending)
    const ids = batch.map((r) => r.id)
    const claimed: Array<number> = []
    yield* deps
      .prompt(
        h,
        session,
        terminal,
        batch.map((r) => r.message).join("\n\n"),
        db.claim(ids).pipe(Effect.tap((got) => Effect.sync(() => claimed.push(...got)))),
      )
      .pipe(
        Effect.flatMap((notStarted) => {
          const rows = batch.filter((r) => claimed.includes(r.id))
          if (rows.length === 0) return Effect.void
          return notStarted
            ? deps.undelivered(session, rows, notStarted)
            : db.setInboxStatus(claimed, "delivered", "sending")
        }),
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) || claimed.length === 0 ? Effect.void : db.setInboxStatus(claimed, "failed", "sending"),
        ),
        // The runtime refused or the session never got ready: failed, the owner told.
        Effect.catchTags({
          // The connection breaking (§ one error type) is not a refusal: before the handover it stays pending for the
          // next check; after, it may have arrived, so it is not sent again (no blind replay); the owner decides.
          RuntimeError: (e) =>
            e.code === "unreachable"
              ? db.pendingInbox(session.id).pipe(
                  Effect.flatMap((pending) =>
                    pending.some((r) => claimed.includes(r.id))
                      ? Effect.fail(e)
                      : deps.undelivered(
                          session,
                          batch.filter((r) => claimed.includes(r.id)),
                          `the connection to ${session.runtime} broke after the message was handed over (${e.message}); it may have reached the session`,
                        ),
                  ),
                )
              : deps.undelivered(
                  session,
                  batch.filter((r) => claimed.includes(r.id)),
                  e.message,
                ),
          // ready() throws before the handover claim: an empty claimed list is not a failed delivery.
          NotReady: (e) => {
            const rows = batch.filter((r) => claimed.includes(r.id))
            if (rows.length > 0) return deps.undelivered(session, rows, e.message)
            return db
              .pendingInbox(session.id)
              .pipe(
                Effect.flatMap((pending) =>
                  ids.some((id) => pending.some((r) => r.id === id)) ? Effect.fail(e) : Effect.void,
                ),
              )
          },
        }),
      )
  })

  /**
   * Ends the turn if the integration already wrote its result. An open round takes a file newer than its prompt. No open
   * round takes a file newer than the last round (closed or not); `closeRound` inserts that round with empty input,
   * and the file's time is stamped on the message, so the same file is not delivered twice.
   * `delivered`: the round went to the parent.
   */
  const collectResult = Effect.fn("Sessions.collectResult")(function* (h: Runtime, session: SessionRow) {
    const terminal = session.address
    const result = yield* readResult(layout.resultFile(session.id)).pipe(Effect.provideService(Harnesses, harnesses))
    if (Option.isNone(result)) return "none" as const
    const found = result.value
    if (session.turnState === "open") {
      if (found.mtimeMs <= session.turnPromptedAt) return "none" as const
    } else {
      // A turn stopped with no round open is `vibest interrupt`'s own (that turn has no result) or no round of vibest's.
      if (found.interrupted) return "none" as const
      const last = yield* db.latestRoundAt(session.id)
      if (last !== undefined && found.mtimeMs <= last) return "none" as const
    }
    // A late file from the harness this session just left is not this round. Leave it: the new harness's write replaces it.
    if (found.harness !== session.harnessId) return "none" as const
    // A usage limit moves the session to another harness (agent.fail); the open round stays the one that finishes.
    if (found.error && isUsageLimitError(found.error)) {
      yield* deps.limitMove.rerun(h, session, terminal.id === "" ? undefined : terminal, "", false, found.error)
      return "delivered" as const
    }
    yield* finish(session, found.error ? "failed" : "completed", found.text, found.error, found.mtimeMs)
    return "delivered" as const
  })

  /**
   * RPC `Prompt`: the user typed into this session's terminal while no round was open: that opens one, `inbox_id` null and
   * the typed text as its input. It ends like any round, with one result to the parent. The main agent is not recorded.
   * `prompt` holds the lock across the send, which is what fires this hook. That echo is not a round: the flag
   * around those sends returns at once, so the hook cannot deadlock. Anything else waits for the lock, then records
   * unless a round is already open.
   */
  const userPrompt = (id: string, text: string, at?: number) =>
    deps.logged(`prompt ${id}`)(
      Effect.gen(function* () {
        if (text.trim() === "") return
        const session = yield* db.getSession(id)
        // getSession never returns the running main agent; an ended main conversation does come back, and is not a round either.
        if (!session || session.agent === "main") return
        const { prompting } = yield* deps.track(id)
        if (yield* Ref.get(prompting)) return
        // Stamped at hook receipt: the lock can be held for seconds (a delivery, an interrupt, a removal), and the
        // typed turn may already be over when it frees. A later stamp would drop that turn's result file. `at`: the
        // caller's stamp at receipt, when it already wrote the turn-start line with it.
        const now = at ?? (yield* Clock.currentTimeMillis)
        // vibest opens its own rounds before handing text over; their echo, and anything typed during a round, is not a round.
        const record = Effect.gen(function* () {
          const current = yield* db.getSession(id)
          if (!current || current.turnState === "open") return false
          const opened = yield* db.beginUserTurn(id, text, { turnPromptedAt: now, lastActive: now })
          // A working round showed up after the read. The text is not a second round, and it is not silent.
          if (!opened)
            yield* Effect.logWarning(`prompt ${id}: a round is already open; the typed text was not recorded`)
        })
        yield* deps.lock(id)(record)
      }),
    )

  return { finish, deliverQueued, collectResult, userPrompt }
}
