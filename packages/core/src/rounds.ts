import { type HarnessUnavailable, NoSuchSession, NotReady } from "@vibest/schema/session"
import { Clock, Effect, Exit, Ref } from "effect"
import type { FileSystem } from "effect"

import {
  type InboxRow,
  type InboxStatus,
  type NewInboxRow,
  type SessionPatch,
  type SessionRow,
  type TurnEnd,
  type TurnReport,
  type TurnState,
  failureOf,
} from "./db.ts"
import type { HarnessDefinition } from "./host.ts"
import { nextBatch } from "./inbox.ts"
import type { LimitMove } from "./move.ts"
import { workspaceGit } from "./project-create.ts"
import { envelope, isUsageLimitError, outcome, parseReport, type ResultStatus } from "./results.ts"
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
    ) => Effect.Effect<InboxRow>
    readonly pendingInbox: (sessionId: string) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly claim: (ids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<number>>
    readonly setInboxStatus: (
      ids: ReadonlyArray<number>,
      status: InboxStatus,
      from?: InboxStatus,
    ) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly latestRoundAt: (sessionId: string) => Effect.Effect<number | undefined>
    readonly latestReport: (sessionId: string, fence: "ready" | "start") => Effect.Effect<TurnReport | undefined>
    readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
    readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
    readonly beginUserTurn: (id: string, text: string, patch: SessionPatch) => Effect.Effect<boolean>
  }
  readonly harnesses: {
    readonly all: ReadonlyArray<HarnessDefinition>
    readonly get: (id: SessionRow["harnessId"]) => Effect.Effect<HarnessDefinition, HarnessUnavailable>
    readonly find: (id: string | null | undefined) => HarnessDefinition | undefined
  }
  readonly track: (id: string) => Effect.Effect<{ readonly prompting: Ref.Ref<boolean> }>
  readonly lock: (id: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly undelivered: (
    session: SessionRow,
    rows: ReadonlyArray<{
      readonly id: number
      readonly message: string
      readonly kind?: string
      readonly sender?: string | null
    }>,
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
  ) => Effect.Effect<string | undefined, NotReady | RuntimeError | HarnessUnavailable, FileSystem.FileSystem>
  readonly limitMove: Pick<LimitMove, "rerun">
}) => {
  const { db, harnesses } = deps

  const finish = Effect.fn("Sessions.finish")(function* (
    session: SessionRow,
    end: Extract<TurnState, "completed" | "failed" | "lost">,
    text: string,
    error: string | undefined,
    at?: number,
    reported?: number,
  ) {
    const report = parseReport(text)
    const status: ResultStatus = end === "completed" && !error ? "completed" : "failed"
    const summary =
      status === "failed" ? outcome(session.name, error) : (report.summary ?? outcome(session.name, error))
    const worktree = yield* deps.worktreeOf(session)
    const repos = yield* workspaceGit(worktree)
    const g = repos ? undefined : yield* gitState(worktree)
    const info = {
      id: session.id,
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
    yield* db.finishTurn(
      session.id,
      {
        status: end,
        ...(reported === undefined ? {} : { report: reported }),
        ...(failure === undefined ? {} : { failure }),
      },
      { turnState: end, lastActive: yield* Clock.currentTimeMillis },
      {
        sessionId: session.id,
        kind: "result",
        message,
        details: { ...info, summary, remember: report.remember, error },
      },
      at,
    )
  })

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
        Effect.catchTags({
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

  const collectResult = Effect.fn("Sessions.collectResult")(function* (h: Runtime | undefined, session: SessionRow) {
    const terminal = session.address
    const adapter = harnesses.find(session.harnessId)
    if (adapter === undefined) return "none" as const
    const found = yield* db.latestReport(session.id, adapter.ready === "integration" ? "ready" : "start")
    if (found === undefined) return "none" as const
    if (found.harness !== session.harnessId) return "none" as const
    if (session.turnState === "open") {
      if (found.at <= session.turnPromptedAt) return "none" as const
    } else {
      if (found.interrupted) return "none" as const
      const last = yield* db.latestRoundAt(session.id)
      if (last !== undefined && found.at <= last) return "none" as const
    }
    if (found.error && isUsageLimitError(found.error)) {
      if (h === undefined) return "none" as const
      yield* deps.limitMove.rerun(h, session, terminal.id === "" ? undefined : terminal, "", false, found.error)
      return "delivered" as const
    }
    if (!adapter.ownSessionId && !session.harnessSessionId && found.conversationId)
      yield* db.updateSession(session.id, { harnessSessionId: found.conversationId })
    yield* finish(session, found.error ? "failed" : "completed", found.text, found.error, found.at, found.id)
    return "delivered" as const
  })

  const userPrompt = (id: string, text: string, at?: number) =>
    deps.logged(`prompt ${id}`)(
      Effect.gen(function* () {
        if (text.trim() === "") return
        const session = yield* db.getSession(id)
        if (!session || session.agent === "main") return
        const { prompting } = yield* deps.track(id)
        if (yield* Ref.get(prompting)) return
        const now = at ?? (yield* Clock.currentTimeMillis)
        const record = Effect.gen(function* () {
          const current = yield* db.getSession(id)
          if (!current || current.turnState === "open") return false
          const opened = yield* db.beginUserTurn(id, text, { turnPromptedAt: now, lastActive: now })
          if (!opened)
            yield* Effect.logWarning(`prompt ${id}: a round is already open; the typed text was not recorded`)
        })
        yield* deps.lock(id)(record)
      }),
    )

  return { finish, deliverQueued, collectResult, userPrompt }
}
