// The round lifecycle of one session: ending a turn, delivering its queued messages, collecting a hook-written
// result (through the builtin check rule when it is configured), and recording a user-typed round (SPEC §8.3, §8.4,
// §11). Everything here runs under the session's lock, held by `check`, `deliver`, `interrupt` or `remove` in
// sessions.ts — except `userPrompt`, which stamps the round at hook receipt and takes the lock only to record it,
// and the check command fiber and the continuation paste, which run outside it. The terminal the row addresses is
// what everything here talks to (runtime-port.md §3).
import { Cause, Clock, Duration, Effect, Exit, Fiber, Option, Ref, Schedule, type Scope, Semaphore } from "effect"
import type { FileSystem } from "effect"
import type * as VibestPlugin from "@vibest/plugin"
import { runCheck } from "./check.ts"
import type { LimitMove } from "./move.ts"
import { errorMessage, type IdleInput } from "./plugins.ts"
import { HookFailed } from "@vibest/schema/plugin"
import { type InboxRow, type InboxStatus, type NewInboxRow, type SessionPatch, type SessionRow, type TurnState } from "./db.ts"
import { Harnesses, type HarnessAdapter } from "./harness.ts"
import { nextBatch } from "./inbox.ts"
import { type AgentState, type Runtime, type RuntimeError, type Terminal } from "./runtimes.ts"
import { envelope, isUsageLimitError, outcome, parseReport, readResult } from "./results.ts"
import { workspaceGit } from "./project-create.ts"
import { gitState } from "./worktree.ts"
import { NoSuchSession, NotReady, SessionBusy } from "@vibest/schema/session"

export const sessionRounds = (deps: {
  readonly db: {
    readonly finishTurn: (id: string, patch: SessionPatch, row: NewInboxRow) => Effect.Effect<InboxRow>
    readonly pendingInbox: (sessionId: string) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly claim: (ids: ReadonlyArray<number>) => Effect.Effect<ReadonlyArray<number>>
    readonly setInboxStatus: (ids: ReadonlyArray<number>, status: InboxStatus, from?: InboxStatus) => Effect.Effect<ReadonlyArray<InboxRow>>
    readonly latestRoundAt: (sessionId: string) => Effect.Effect<number | undefined>
    readonly updateSession: (id: string, patch: SessionPatch) => Effect.Effect<void>
    readonly coverRound: (sessionId: string, at: number) => Effect.Effect<void>
    readonly getSession: (id: string) => Effect.Effect<SessionRow | undefined>
    readonly beginUserTurn: (id: string, text: string, patch: SessionPatch) => Effect.Effect<boolean>
  }
  readonly inbox: { readonly announce: (row: InboxRow) => Effect.Effect<void> }
  readonly layout: { readonly resultFile: (id: string) => string; readonly reportFile: (id: string) => string }
  readonly harnesses: {
    readonly all: ReadonlyArray<HarnessAdapter>
    readonly get: (id: SessionRow["harnessId"]) => HarnessAdapter
    readonly find: (id: string | null | undefined) => HarnessAdapter | undefined
  }
  /** The session's in-memory state: its lock, the flag set while vibest itself pastes a prompt, and the check rule's fibers. */
  readonly track: (id: string) => Effect.Effect<{
    readonly lock: Semaphore.Semaphore
    readonly prompting: Ref.Ref<boolean>
    readonly sawWorking: Ref.Ref<boolean>
    readonly endedAt: Ref.Ref<number | undefined>
    readonly blockedNotified: Ref.Ref<boolean>
    /** Check command in flight for one result mtime. */
    readonly checking: Ref.Ref<{ readonly mtime: number; readonly fiber: Fiber.Fiber<void>; readonly token: number } | undefined>
    /** A continuation paste is in flight. Its wait holds no lock, so a second check must not paste too. */
    readonly pasting: Ref.Ref<boolean>
  }>
  /** Take the session's lock again from code that runs outside it (the check command fiber, a continuation paste). */
  readonly locked: (id: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
  /** Where the check command fiber is forked. */
  readonly scope: Scope.Scope
  readonly plugins: { readonly idle: (input: IdleInput) => Effect.Effect<VibestPlugin.AgentIdle, HookFailed> }
  readonly paneTail: (h: Runtime, terminal: Terminal | undefined) => Effect.Effect<string>
  /** The turn was picked up: the runtime reports it working, or a turn-start report line of the round exists (§5). */
  readonly pickedUp: (h: Runtime, session: SessionRow, terminal: Terminal) => Effect.Effect<boolean, unknown, FileSystem.FileSystem>
  readonly busy: (state: AgentState) => boolean
  /** Interrupt key, then wait for the agent to settle; false when it did not within the wait. */
  readonly interruptAgent: (h: Runtime, session: SessionRow, terminal: Terminal) => Effect.Effect<boolean, RuntimeError>
  readonly confirmTimeout: Duration.Duration
  readonly stopWait: Duration.Duration
  readonly worktreeOf: (session: SessionRow) => Effect.Effect<string, NoSuchSession>
  readonly notice: (session: SessionRow, message: string) => Effect.Effect<unknown>
  readonly undelivered: (session: SessionRow, rows: ReadonlyArray<{ readonly id: number; readonly message: string }>, reason: string) => Effect.Effect<unknown>
  readonly logged: (what: string) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<void | A, never, R>
  readonly prompt: (h: Runtime, session: SessionRow, terminal: Terminal, text: string, onHandover?: Effect.Effect<void>, options?: { readonly keepRound?: boolean }) => Effect.Effect<string | undefined, NotReady | RuntimeError, FileSystem.FileSystem>
  /** The usage-limit move (move.ts), wired in after the rounds exist. */
  readonly limitMove: Pick<LimitMove, "rerun">
}) => {
  const { db, inbox, layout, harnesses } = deps

  const TICK = Schedule.spaced("500 millis")

  const finish = Effect.fn("Sessions.finish")(function* (
    session: SessionRow,
    end: Extract<TurnState, "completed" | "failed" | "lost">,
    text: string,
    error: string | undefined,
    tail = "",
  ) {
    const report = parseReport(text)
    const worktree = yield* deps.worktreeOf(session)
    const repos = yield* workspaceGit(worktree)
    const g = repos ? undefined : yield* gitState(worktree)
    const info = {
      id: session.id,
      // A session reports as the agent it runs.
      agent: session.agent,
      harness: session.harnessId,
      name: session.name,
      status: error ? "failed" : report.status,
      branch: repos ? repos.map((r) => `${r.name}=${r.branch}`).join("\n") : (g?.branch ?? ""),
      pushed: repos ? repos.map((r) => `${r.name}=${r.pushed}`).join("\n") : String(g?.pushed ?? false),
      worktree,
    }
    const body = [text, error ? `error: ${error}` : "", tail ? `terminal tail:\n${tail}` : ""].filter(Boolean).join("\n\n")
    const message = envelope(
      "agent-result",
      [
        ["agent-id", session.id],
        ["status", info.status],
        ["summary", outcome(session.name, info.status, error)],
        ["harness", session.harnessId],
        ["branch", info.branch],
        ["pushed", repos ? info.pushed : info.branch ? info.pushed : ""],
        ["worktree", worktree],
      ],
      ["result", body],
    )
    const acceptance = session.metadata.check?.acceptance
    const { check: _check, ...metadata } = session.metadata
    const row = yield* db.finishTurn(
      session.id,
      {
        turnState: end,
        lastActive: yield* Clock.currentTimeMillis,
        // The round is over: the next one starts its check attempt count at zero.
        ...(session.metadata.check ? { metadata } : {}),
      },
      {
        sessionId: session.id,
        kind: "result",
        message,
        details: { ...info, summary: report.summary, remember: report.remember, error, ...(acceptance && acceptance.length > 0 ? { acceptance } : {}) },
      },
    )
    yield* inbox.announce(row)
  })

  /**
   * Queued messages for an idle session: one wake = one delivery, consecutive rows from one sender merged (SPEC §11.1, §11.4).
   * The batch goes pending → sending (handed to the runtime) → delivered, or failed with the owner told; only its own rows.
   */
  const deliverQueued = Effect.fn("Sessions.deliverQueued")(function* (h: Runtime, session: SessionRow, terminal: Terminal) {
    const pending = yield* db.pendingInbox(session.id)
    if (pending.length === 0) return
    const batch = nextBatch(pending)
    const ids = batch.map((r) => r.id)
    const claimed: Array<number> = []
    yield* deps.prompt(h, session, terminal, batch.map((r) => r.message).join("\n\n"), db.claim(ids).pipe(Effect.tap((got) => Effect.sync(() => claimed.push(...got))))).pipe(
      Effect.flatMap((notStarted) => {
        const rows = batch.filter((r) => claimed.includes(r.id))
        if (rows.length === 0) return Effect.void
        return notStarted ? deps.undelivered(session, rows, notStarted) : db.setInboxStatus(claimed, "delivered", "sending")
      }),
      Effect.onExit((exit) => (Exit.isSuccess(exit) || claimed.length === 0 ? Effect.void : db.setInboxStatus(claimed, "failed", "sending"))),
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
                    : deps.undelivered(session, batch.filter((r) => claimed.includes(r.id)), `the connection to ${session.runtime} broke after the message was handed over (${e.message}); it may have reached the session`),
                ),
              )
            : deps.undelivered(session, batch.filter((r) => claimed.includes(r.id)), e.message),
        // ready() throws before the handover claim: an empty claimed list is not a failed delivery.
        NotReady: (e) => {
          const rows = batch.filter((r) => claimed.includes(r.id))
          if (rows.length > 0) return deps.undelivered(session, rows, e.message)
          return db.pendingInbox(session.id).pipe(
            Effect.flatMap((pending) => (ids.some((id) => pending.some((r) => r.id === id)) ? Effect.fail(e) : Effect.void)),
          )
        },
      }),
    )
  })

  /** Filled in once the locked check exists: the command fiber must not close over it while it is being defined. */
  const nextCheck: { run: (id: string) => Effect.Effect<void> } = { run: () => Effect.void }

  /**
   * Run the check command outside the session lock, store its outcome, then let a later locked `check` apply it.
   * A second call for the same result mtime finds `ran` and does not start another command.
   */
  let nextToken = 0
  const settleCheck = (id: string, mtime: number, command: string, cwd: string, token: number) =>
    Effect.gen(function* () {
      const ran = yield* runCheck(command, cwd)
      yield* deps.locked(id)(Effect.gen(function* () {
        const session = yield* db.getSession(id)
        if (!session || session.turnState !== "open") return
        const result = yield* readResult(layout.resultFile(id)).pipe(Effect.provideService(Harnesses, harnesses))
        if (Option.isNone(result) || result.value.mtimeMs !== mtime) return
        if (session.metadata.check?.mtime === mtime && session.metadata.check.ran) return
        const previous = session.metadata.check
        const time = yield* Clock.currentTimeMillis
        yield* db.updateSession(id, {
          metadata: {
            ...session.metadata,
            check: {
              mtime,
              attempts: (previous?.attempts ?? 0) + 1,
              ran,
              acceptance: [...(previous?.acceptance ?? []), { reviewer: "check" as const, outcome: ran.ok ? "pass" as const : "fail" as const, summary: ran.tail, time }],
              ...(previous?.deliverFailed ? { deliverFailed: true } : {}),
            },
          },
          lastActive: time,
        })
      }))
      yield* nextCheck.run(id)
    }).pipe(
      // Not under the session lock: remove interrupts this fiber while it holds that lock.
      Effect.ensuring(Effect.gen(function* () {
        const tracked = yield* deps.track(id)
        yield* Ref.update(tracked.checking, (current) => current?.token === token ? undefined : current)
      })),
      deps.logged(`check command ${id}`),
    )

  /** The row may still take a continuation paste: the turn is open and interrupt did not choose delivery. */
  const stillPastable = (id: string) =>
    deps.locked(id)(db.getSession(id).pipe(
      Effect.map((session) => !!session && session.turnState === "open" && session.metadata.check?.deliverFailed !== true),
    ))

  /** Poll until the turn is picked up (§5), or false after `confirmTimeout`. Writes nothing. */
  const awaitPickup = (h: Runtime, session: SessionRow, terminal: Terminal) =>
    deps.pickedUp(h, session, terminal).pipe(
      Effect.repeat({ until: (picked) => picked, schedule: TICK }),
      Effect.timeoutOrElse({ duration: deps.confirmTimeout, orElse: () => Effect.succeed(false) }),
    )

  /**
   * Prompt, Enter, one re-paste. Stops when `pickup` is true. Writes nothing.
   * `allow` false (a continuation whose turn closed, or `deliverFailed`) stops before the next send: `"stopped"`.
   */
  const pasteText = (h: Runtime, session: SessionRow, terminal: Terminal, text: string, pickup: Effect.Effect<boolean, unknown, FileSystem.FileSystem>, allow: Effect.Effect<boolean, unknown>) => {
    const send = h.send(terminal, { text })
    return Effect.gen(function* () {
      if (!(yield* allow)) return "stopped" as const
      yield* send
      if (yield* pickup) return true as const
      if (!(yield* allow)) return "stopped" as const
      yield* h.send(terminal, { keys: ["enter"] }).pipe(Effect.ignore)
      if (yield* pickup) return true as const
      if (!(yield* allow)) return "stopped" as const
      // Re-paste once only, so a task never runs twice.
      yield* send.pipe(Effect.ignore)
      return (yield* pickup) ? true as const : false as const
    })
  }

  /**
   * Paste outside the session lock. The caller already read the state once (idle) and released the lock.
   * Re-take only to re-read the row before each send, and to write the cursors after the turn is picked up.
   * The pickup wait itself holds no lock. A closed turn or `deliverFailed` does not paste and does not notice.
   * The notice is only for a paste that was sent and not confirmed.
   */
  const continuePaste = (h: Runtime, session: SessionRow, terminal: Terminal, text: string, mtimeMs: number) => {
    const unpasted = (reason: string) =>
      deps.locked(session.id)(Effect.gen(function* () {
        const row = yield* db.getSession(session.id)
        if (!row || row.turnState !== "open" || row.metadata.check?.deliverFailed === true) return
        yield* deps.notice(row, `${session.id}: the check output could not be pasted; ${reason}`)
      }))
    return Effect.gen(function* () {
      // Stamped before the paste, and pickup is proven against that stamp: the round's own earlier start line does not count.
      const pasted = yield* Clock.currentTimeMillis
      const started = yield* pasteText(
        h,
        session,
        terminal,
        text,
        awaitPickup(h, { ...session, turnPromptedAt: pasted }, terminal),
        stillPastable(session.id),
      )
      if (started === "stopped") return
      if (started === true) {
        return yield* deps.locked(session.id)(Effect.gen(function* () {
          const row = yield* db.getSession(session.id)
          if (!row || row.turnState !== "open" || row.metadata.check?.deliverFailed === true) return
          const tracked = yield* deps.track(session.id)
          yield* Ref.set(tracked.endedAt, undefined)
          yield* Ref.set(tracked.blockedNotified, false)
          yield* Ref.set(tracked.sawWorking, true)
          const at = Math.max(pasted, mtimeMs)
          yield* db.updateSession(session.id, { turnState: "open", turnPromptedAt: at })
        }))
      }
      const tail = yield* deps.paneTail(h, terminal)
      yield* unpasted(`task_not_started: ${session.id} did not start working on the message.\n\nterminal tail:\n${tail}`)
    }).pipe(Effect.catch((error) => unpasted(errorMessage(Cause.fail(error)))))
  }

  /** Interrupt decided this failing check is delivered, not pasted. Stays until `finish` writes that result. */
  const rememberStop = (session: SessionRow, mtime: number) => {
    if (session.metadata.check?.deliverFailed && session.metadata.check.mtime === mtime) return Effect.void
    const previous = session.metadata.check
    const same = previous?.mtime === mtime ? previous : undefined
    return db.updateSession(session.id, {
      metadata: {
        ...session.metadata,
        check: {
          mtime,
          attempts: previous?.attempts ?? 0,
          ...(same?.ran ? { ran: same.ran } : {}),
          acceptance: previous?.acceptance ?? [],
          deliverFailed: true,
        },
      },
    })
  }

  /**
   * Ends the turn if the integration already wrote its result. An open round takes a file newer than its prompt. No open
   * round takes a file newer than the last round (closed or not); `closeRound` inserts that round with empty input,
   * and the file's time is stamped on the message, so the same file is not delivered twice.
   * `delivered`: the round went to the parent. `pending`: a check command is running, or the agent is not idle yet
   * (the next poll pastes; no notice). A paste is not done here: `parked.paste` runs after the session lock is released.
   * `stop` (interrupt): a failing check is delivered as failed and never pasted back; one still running is killed
   * and delivered unchecked, not waited out.
   */
  const collectResult = Effect.fn("Sessions.collectResult")(function* (
    h: Runtime,
    session: SessionRow,
    mode: "deliver" | "stop" = "deliver",
    liveState?: AgentState,
    parked?: { paste?: Effect.Effect<void, unknown, FileSystem.FileSystem> },
  ) {
    const terminal = session.address
    const result = yield* readResult(layout.resultFile(session.id)).pipe(Effect.provideService(Harnesses, harnesses))
    if (Option.isNone(result)) return "none" as const
    const found = result.value
    if (session.turnState === "open") {
      if (found.mtimeMs <= session.turnPromptedAt) return "none" as const
    } else {
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
    // The runtime reported no session id (Cursor): the hook's own conversation id lets the session be resumed.
    if (!harnesses.get(session.harnessId).ownSessionId && !session.harnessSessionId && found.conversationId)
      yield* db.updateSession(session.id, { harnessSessionId: found.conversationId })
    // A round that is not open was never vibest's to check, and a harness failure (a StopFailure) is the result:
    // neither gets the check command run over it.
    if (session.turnState !== "open" || found.error) {
      yield* finish(session, found.error ? "failed" : "completed", found.text, found.error)
      yield* db.coverRound(session.id, found.mtimeMs)
      return "delivered" as const
    }
    const directory = yield* deps.worktreeOf(session)
    const tracked = yield* deps.track(session.id)
    const stored = session.metadata.check
    const same = stored?.mtime === found.mtimeMs ? stored : undefined
    const idle = yield* deps.plugins.idle({
      sessionId: session.id,
      agentType: session.agent,
      directory,
      answer: found.text,
      checkAttempts: same?.attempts ?? stored?.attempts ?? 0,
      ran: same?.ran,
    }).pipe(
      // A crashed or timed-out idle callback is never skipped silently: the round is delivered failed with its error.
      Effect.catchTag("HookFailed", (hook) =>
        finish(session, "failed", found.text, `agent.idle failed: ${hook.message}`).pipe(
          Effect.andThen(db.coverRound(session.id, found.mtimeMs)),
          Effect.as(undefined),
        )),
    )
    if (idle === undefined) return "delivered" as const
    const stop = mode === "stop" || stored?.deliverFailed === true
    if (same?.ran === undefined && idle.command !== undefined) {
      const running = yield* Ref.get(tracked.checking)
      // Stop does not wait out a check (CHECK_TIMEOUT is minutes): kill the running command fiber (its finalizer
      // kills the process group) and deliver the result now, marked failed as unchecked.
      if (stop) {
        if (running?.mtime === found.mtimeMs) yield* Fiber.interrupt(running.fiber)
        yield* rememberStop(session, found.mtimeMs)
        yield* finish(session, "failed", found.text, "check interrupted")
        yield* db.coverRound(session.id, found.mtimeMs)
        return "delivered" as const
      }
      if (running?.mtime === found.mtimeMs) return "pending" as const
      const token = ++nextToken
      // ponytail: not counted by Drain (a check can run for minutes); a planned restart kills it and the next vibestd runs it again from the start.
      const fiber = yield* Effect.forkIn(settleCheck(session.id, found.mtimeMs, idle.command, directory, token), deps.scope)
      yield* Ref.set(tracked.checking, { mtime: found.mtimeMs, fiber, token })
      return "pending" as const
    }
    if (stop && (idle.prompt !== undefined || idle.output !== undefined)) {
      if (liveState !== undefined && deps.busy(liveState) && !(yield* deps.interruptAgent(h, session, terminal))) {
        yield* rememberStop(session, found.mtimeMs)
        return yield* new SessionBusy({ id: session.id, message: `${session.id} did not stop within ${Duration.format(deps.stopWait)}; it may still be working` })
      }
      yield* finish(session, "failed", found.text, "check failed", idle.output ?? idle.prompt ?? "")
      yield* db.coverRound(session.id, found.mtimeMs)
      return "delivered" as const
    }
    if (idle.prompt !== undefined) {
      // `liveState` is the one state read `check` already took. Missing: that check's exited path finishes the round.
      // Not idle: no wait and no notice. The poll is the wait.
      if (liveState === undefined) return "none" as const
      if (liveState !== "idle") return "pending" as const
      const row = yield* deps.track(session.id)
      if ((yield* Ref.get(row.pasting)) || parked === undefined) return "pending" as const
      yield* Ref.set(row.pasting, true)
      parked.paste = continuePaste(h, session, terminal, idle.prompt, found.mtimeMs)
      return "pending" as const
    }
    // `output` is not a decision, so later plugins could still have set `prompt`. None did: the check failed for good.
    if (idle.output !== undefined) {
      yield* finish(session, "failed", found.text, "check failed", idle.output)
      yield* db.coverRound(session.id, found.mtimeMs)
      return "delivered" as const
    }
    yield* finish(session, "completed", found.text, undefined)
    yield* db.coverRound(session.id, found.mtimeMs)
    return "delivered" as const
  })

  /**
   * RPC `Prompt`: the user typed into this session's terminal while no round was open: that opens one, `inbox_id` null and
   * the typed text as its input. It ends like any round, with one result to the parent. The main agent is not recorded.
   * `prompt` holds the lock across the send, which is what fires this hook. That echo is not a round: the flag
   * around those sends returns at once, so the hook cannot deadlock. Anything else waits for the lock, then records
   * unless a round is already open.
   */
  const userPrompt = (id: string, text: string) =>
    deps.logged(`prompt ${id}`)(
      Effect.gen(function* () {
        if (text.trim() === "") return
        const session = yield* db.getSession(id)
        // getSession never returns the running main agent; an ended main conversation does come back, and is not a round either.
        if (!session || session.agent === "main") return
        const { lock, prompting } = yield* deps.track(id)
        if (yield* Ref.get(prompting)) return
        // Stamped at hook receipt: the lock can be held for seconds (a delivery, an interrupt, a removal), and the
        // typed turn may already be over when it frees. A later stamp would drop that turn's result file.
        const now = yield* Clock.currentTimeMillis
        // vibest opens its own rounds before handing text over; their echo, and anything typed during a round, is not a round.
        const record = Effect.gen(function* () {
          const current = yield* db.getSession(id)
          if (!current || current.turnState === "open") return false
          const opened = yield* db.beginUserTurn(id, text, { turnPromptedAt: now, lastActive: now })
          // A working round showed up after the read. The text is not a second round, and it is not silent.
          if (!opened) yield* Effect.logWarning(`prompt ${id}: a round is already open; the typed text was not recorded`)
        })
        yield* lock.withPermit(record)
      }),
    )

  return { finish, deliverQueued, collectResult, userPrompt, nextCheck }
}
