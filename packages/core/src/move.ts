import type * as VibestPlugin from "@vibest/plugin"
import { isLimited, stillLimited } from "@vibest/plugin"
import type { Subscription } from "@vibest/schema/subscription"
// The usage-limit move (architecture.md §8): a round that failed on a usage limit restarts the same session, in its
// same worktree with the same task, on another harness the `agent.fail` chain chooses; the open round stays the one
// that finishes. Runs under the session's lock, wherever the limit surfaced (a turn's reported end, a launch start
// that died on the login's own limit). Everything a plugin host cannot decide — terminals, rows, the round — is here.
import { Cause, Clock, Context, Crypto, Effect, Exit, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"

import type { Db, SessionRow } from "./db.ts"
import { Harness, harnessOptions, Harnesses, preflight, type HarnessAdapter, isHarnessId } from "./harness.ts"
import { errorMessage, type Plugins } from "./plugins.ts"
import { RuntimeError } from "./runtimes.ts"
import { type Machine, type Runtime, type Terminal } from "./runtimes.ts"
import type { Subscriptions } from "./subscriptions/service.ts"

/** The platform services `Sessions.make` closes over and hands to the move. */
export type MovePlatform = FileSystem.FileSystem | Path.Path | Crypto.Crypto | ChildProcessSpawner.ChildProcessSpawner

/** What a move asks of its host: open a terminal, prompt, finish a round. All under the session's lock. */
export interface LimitMove {
  /**
   * Restart the session on another harness; `error` is the harness's own limit text. False: it ended (the round
   * failed).
   */
  readonly rerun: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal | undefined,
    fallbackTask: string,
    ownsTerminal: boolean,
    error: string,
  ) => Effect.Effect<boolean>
}

/**
 * The late-wired home of the move (sessions.ts fills it once placement and rounds exist): rounds' `collectResult`
 * and placement's launch hand a limit to `rerun`.
 */
export const limitMoveBox = (): {
  readonly move: {
    rerun: LimitMove["rerun"]
  }
} => ({ move: { rerun: () => Effect.die("limit move not wired") as Effect.Effect<boolean> } })

export const sessionMove = (deps: {
  readonly db: Pick<Db["Service"], "getSession" | "updateSession" | "rescheduleSource" | "endProcess">
  readonly plugins: Plugins["Service"]
  readonly subscriptions: Subscriptions["Service"]
  readonly harness: Harness["Service"]
  readonly harnesses: { readonly get: (id: SessionRow["harnessId"]) => HarnessAdapter }
  /** The session's in-memory turn state. */
  readonly track: (id: string) => Effect.Effect<{ readonly sawWorking: import("effect").Ref.Ref<boolean> }>
  /** `keepRound` on: a miss leaves the open round working, so the next harness prompts it again. */
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover?: Effect.Effect<void>,
    options?: { readonly keepRound?: boolean },
  ) => Effect.Effect<string | undefined, unknown, MovePlatform>
  /** The session's next terminal (placement's `openTerminal`): starts `argv`, records the address on the row. */
  readonly open: (
    h: Runtime,
    machine: Machine,
    session: SessionRow,
    input: {
      readonly project: string
      readonly cwd: string
      readonly argv: ReadonlyArray<string>
      /** The project key: its scratch directory is the session's VIBEST_SCRATCH. */
      readonly key: string
      readonly near?: Terminal | undefined
    },
  ) => Effect.Effect<Terminal, unknown, MovePlatform>
  readonly show: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    root: string,
  ) => Effect.Effect<void, unknown, MovePlatform>
  /** Where the session works now, and which project key its system prompt uses. */
  readonly locate: (
    session: SessionRow,
  ) => Effect.Effect<{ readonly root: string; readonly cwd: string; readonly key: string }, unknown, MovePlatform>
  /** The harness argv a terminal runs (sessions.ts `launchArgv`). */
  readonly launchArgv: (
    session: SessionRow,
    resume: boolean,
    key: string,
  ) => Effect.Effect<ReadonlyArray<string>, unknown, MovePlatform>
  readonly finish: (
    session: SessionRow,
    end: "failed",
    text: string,
    error: string | undefined,
  ) => Effect.Effect<unknown, unknown, MovePlatform>
  /** The reported turn ends: the old harness's end is dropped (turn-ends.ts). */
  readonly turnEnds: { readonly drop: (id: string) => Effect.Effect<void> }
  /** The session's system prompt, made now from its row and the project files (sessions.ts `systemPromptOf`). */
  readonly systemPromptOf: (session: SessionRow, key: string) => Effect.Effect<string, unknown, MovePlatform>
  readonly uuid: Effect.Effect<string>
  /** SIGTERM to the harness pid alone (never its group: that is the terminal's shell). */
  readonly terminate: (pid: number) => Effect.Effect<"sent" | "gone" | "denied">
  readonly platform: Context.Context<MovePlatform>
}) => {
  const { db, plugins, subscriptions, harness, harnesses } = deps

  /**
   * `agent.fail` for a usage limit, then the same session in the same directory with the same task. The task is the
   * open round's input, else the text this launch was about to send, else the trailing delivered batch. That open
   * round stays the one that finishes. False: it ended. `ownsTerminal` is the launch terminal, closed on giving up; a
   * move then owns the new terminal. The original stays when nothing moved.
   */
  const rerunBody = Effect.fn("Sessions.rerunLimited")(function* (
    h: Runtime,
    session: SessionRow,
    current: Terminal | undefined,
    fallbackTask: string,
    ownsTerminal: boolean,
    error: string,
  ) {
    const machine: Machine = { id: session.address.machine }
    const source = yield* db.rescheduleSource(session.id)
    const task = source.working || fallbackTask || source.delivered
    let row = session
    let terminal = current
    let owns = ownsTerminal
    // Set once this move closed the session's own terminal: a later give-up marks the row exited, for nothing is left.
    let gone = false
    // In place: the runtime runs the next harness in the session's own terminal once only the harness there ended (no
    // terminal closes). `running` is the harness in that terminal: the limited one, one this move started, or none.
    const inPlace = current !== undefined && h.run !== undefined && session.metadata.pid !== undefined
    let running: "old" | "mine" | "none" = "old"
    const endRunning = Effect.gen(function* () {
      if (running === "none") return "sent" as const
      const pid = ((yield* db.getSession(row.id)) ?? row).metadata.pid
      const sent = pid === undefined ? "gone" : yield* deps.terminate(pid)
      // Its pid and ready report go with its process (`process.end`): the limited one, or one this move started.
      if (sent !== "denied") {
        yield* db.endProcess(row.id, limitedEnded ? "move" : "limited")
        limitedEnded = true
        running = "none"
      }
      return sent
    })
    // The limit that started this move is a real try: its process ends with reason `limited` (the row's attempts),
    // which survives a vibestd restart. A login the row never named has no provider; the plugin's Attempt carries it
    // as undefined.
    const at = yield* Clock.currentTimeMillis
    const stored = session.metadata.attempts ?? []
    const provider = session.provider ?? undefined
    const recorded = stored.some((a) => a.harness === session.harnessId && a.provider === provider)
      ? stored
      : [...stored, { harness: session.harnessId, provider, outcome: "limited" as const, at }]
    /** The process this move leaves behind ends: the limited one first, any later one a failed try of this move. */
    let limitedEnded = false
    const endLeft = Effect.gen(function* () {
      yield* db.endProcess(row.id, limitedEnded ? "move" : "limited")
      limitedEnded = true
    })
    // A preflight miss, a refused or failed start, or an unconfirmed prompt. This move only.
    const skipped: Array<VibestPlugin.Attempt> = []
    const skip = (harness: string, outcome: Exclude<VibestPlugin.Attempt["outcome"], "limited">) => {
      if (!skipped.some((a) => a.harness === harness)) skipped.push({ harness, provider: undefined, outcome, at })
    }
    // What every hook in this move sees: the session's real tries, oldest first, plus this move's skips.
    const attempts = (): ReadonlyArray<VibestPlugin.Attempt> => [
      ...recorded.map((a) => ({ ...a, provider: a.provider })),
      ...skipped,
    ]
    const left = () =>
      Effect.gen(function* () {
        const mine = recorded.map((a) => (a.provider !== undefined ? `${a.harness}/${a.provider}` : a.harness))
        const reported = (yield* subscriptions.list)
          .filter(isLimited)
          .map((s) => (s.provider !== "" ? `${s.harness}/${s.provider}` : s.harness))
        const other =
          skipped.length === 0 ? "" : `; ${skipped.map((a) => a.harness).join(", ")} tried and did not start`
        const all = reported.length === 0 ? "" : ` (${reported.join(", ")} limited)`
        return `no harness left for ${row.id}: ${mine.join(", ")} hit a usage limit${other} and no other candidate is available${all}`
      })
    // One stop. Close the terminal this attempt owns; set exitedAt only after that close succeeds. A failed close is one failed
    // result and leaves the terminal. Owning no terminal (the turn-end no-move path) leaves the agent running: the turn fails
    // but exitedAt stays unset, so check keeps polling it and listSessions keeps showing it.
    const giveUp = (why: string) =>
      Effect.gen(function* () {
        const fresh = (yield* db.getSession(row.id)) ?? row
        // In place the terminal stays: a harness this move started ends; the limited one, never ended, keeps running.
        if (inPlace) {
          if (running === "mine") yield* endRunning
          yield* deps.finish(fresh, "failed", "", why)
          if (running === "none") {
            const t = yield* Clock.currentTimeMillis
            yield* db.updateSession(fresh.id, {
              status: "unknown",
              exitedAt: t,
              lastActive: t,
              end: limitedEnded ? "move" : "limited",
            })
          }
          return false
        }
        if (!(owns && terminal)) {
          yield* deps.finish(fresh, "failed", "", why)
          return false
        }
        const closed = yield* h.close(terminal).pipe(Effect.exit)
        if (Exit.isFailure(closed)) {
          yield* deps.finish(
            fresh,
            "failed",
            "",
            `${fresh.id} stopped after a usage limit, but closing its terminal failed (${errorMessage(closed.cause)})`,
          )
          return false
        }
        yield* deps.finish(fresh, "failed", "", why)
        const t = yield* Clock.currentTimeMillis
        yield* db.updateSession(fresh.id, {
          status: "unknown",
          exitedAt: t,
          lastActive: t,
          end: limitedEnded ? "move" : "limited",
        })
        return false
      })
    const options = yield* harnessOptions.pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
    )
    // A choice the chain already ruled out (an unknown harness, a login that already hit its limit, or one this move
    // already skipped) ends the move: re-asking the same plugins the same question cannot change the answer. A limit
    // whose login's own row was refreshed after it and says it is free again no longer rules anything out.
    const ruledOut = (
      move: { harness: string | undefined; provider?: string | undefined } | undefined,
      rows: ReadonlyArray<Subscription>,
    ) => {
      if (move === undefined || !isHarnessId(move.harness ?? "")) return true
      const provider = move.provider ?? ""
      return attempts().some(
        (a) =>
          a.harness === move.harness &&
          (a.outcome !== "limited" || a.provider === undefined || (a.provider === provider && stillLimited(a, rows))),
      )
    }
    // The move stays in the session's directory with its system prompt: what both hook calls repeat.
    const { root, cwd, key } = yield* deps.locate(session)
    const base = {
      project: root,
      agentType: session.agent,
      parentSessionId: source.parentSessionId,
      harnesses: options,
    }
    while (true) {
      const rows = yield* subscriptions.list
      const decided = yield* plugins
        .fail({
          ...base,
          sessionId: row.id,
          reason: "limited",
          error,
          turn: task,
          harness: row.harnessId,
          provider: row.provider ?? undefined,
          attempts: attempts(),
        })
        .pipe(Effect.exit)
      if (Exit.isFailure(decided)) return yield* giveUp(`${yield* left()}: ${errorMessage(decided.cause)}`)
      if (ruledOut(decided.value.move, rows)) return yield* giveUp(yield* left())
      const move = decided.value.move!
      // The candidate runs the same start chain a first start does, prefilled with the move: a start policy or a
      // refusal applies to a moved Agent too, and what the chain decides is what gets patched and started.
      // The move stays on the session's own runtime and machine; the chain's `runtime` is prefilled so nothing re-chooses it.
      const decidedStart = yield* plugins
        .start({
          ...base,
          prompt: task,
          harness: move.harness,
          provider: move.provider,
          model: move.model,
          attempts: attempts(),
          machine: { id: session.address.machine },
          runtime: session.runtime,
          parentRuntime: undefined,
          machines: [],
        })
        .pipe(Effect.exit)
      const next = Exit.isSuccess(decidedStart) ? decidedStart.value : undefined
      if (next === undefined || next.harness === undefined || !isHarnessId(next.harness)) {
        skip(move.harness, "refused")
        continue
      }
      // The start chain sending the move back to a harness or login it already ruled out cannot make progress: stop, not loop.
      if (ruledOut(next, rows)) return yield* giveUp(yield* left())
      const checked = yield* preflight(next.harness, next.provider ?? null, next.model ?? null).pipe(
        Effect.provideService(Harness, harness),
        Effect.provideService(Harnesses, harnesses),
        Effect.exit,
      )
      if (Exit.isFailure(checked)) {
        skip(next.harness, "unavailable")
        continue
      }
      // End the old agent before the next starts: a refused signal or a failed close keeps the old row, and no second
      // agent ever runs. In place only its harness ends; otherwise its terminal closes.
      if (inPlace) {
        if ((yield* endRunning) === "denied") {
          yield* deps.turnEnds.drop(row.id)
          yield* deps.finish(
            row,
            "failed",
            "",
            `${row.id} stayed on ${row.harnessId}: SIGTERM to its harness was refused`,
          )
          return false
        }
      } else if (terminal !== undefined) {
        const closed = yield* h.close(terminal).pipe(Effect.exit)
        if (Exit.isFailure(closed)) {
          yield* deps.turnEnds.drop(row.id)
          yield* deps.finish(
            row,
            "failed",
            "",
            `${row.id} stayed on ${row.harnessId}: closing its terminal failed (${errorMessage(closed.cause)})`,
          )
          return false
        }
        terminal = undefined
        owns = false
        gone = true
        yield* endLeft
      } else yield* endLeft
      // The terminal places before the row names the harness, so a failed place leaves the row on the last live one.
      const harnessSessionId = harnesses.get(next.harness).ownSessionId ? yield* deps.uuid : null
      const nextRow: SessionRow = {
        ...row,
        harnessId: next.harness,
        provider: next.provider ?? null,
        model: next.model ?? null,
        harnessSessionId,
      }
      const argv = yield* deps.launchArgv(nextRow, false, key)
      // In place the terminal is the same: the next harness's process starts there before it runs, so what it reports
      // while starting is its own.
      if (inPlace)
        yield* db.updateSession(row.id, {
          harnessId: next.harness,
          provider: next.provider ?? null,
          model: next.model ?? null,
          harnessSessionId,
        })
      const placed = inPlace
        ? yield* h.run!(terminal!, argv).pipe(Effect.as(terminal!), Effect.exit)
        : yield* deps.open(h, machine, nextRow, { project: root, cwd, key, argv }).pipe(Effect.exit)
      if (Exit.isFailure(placed)) {
        // The one error type has a `code`, and that is all core may decide on: `open`'s `failed` is the start dying
        // inside the terminal (its own limit, a crash) — skip to the next harness. Any other code is a placement
        // refusal and ends the move, as a failed place always did.
        const failed = Cause.squash(placed.cause)
        const startDeath = failed instanceof RuntimeError && failed.code === "failed"
        if (!startDeath) {
          yield* deps.finish(
            row,
            "failed",
            "",
            `${row.id} stopped after a usage limit, but placing the next pane failed (${errorMessage(placed.cause)})`,
          )
          if (gone || inPlace) {
            const t = yield* Clock.currentTimeMillis
            yield* db.updateSession(row.id, { status: "unknown", exitedAt: t, lastActive: t, end: "move" })
          }
          return false
        }
        skip(next.harness, "start_failed")
        continue
      }
      terminal = placed.value
      if (inPlace) running = "mine"
      else owns = true
      yield* db.updateSession(row.id, {
        harnessId: next.harness,
        provider: next.provider ?? null,
        model: next.model ?? null,
        harnessSessionId,
        exitedAt: null,
      })
      row = (yield* db.getSession(row.id))!
      yield* deps.turnEnds.drop(row.id)
      const text = harnesses.get(row.harnessId).systemPromptInPrompt
        ? `${yield* deps.systemPromptOf(row, key)}\n\n# Task\n\n${next.prompt}`
        : next.prompt
      const prompted = yield* deps.prompt(h, row, terminal, text, Effect.void, { keepRound: true }).pipe(Effect.exit)
      // A reason is the runtime taking the text and the turn never starting. Same as a failed prompt: try the next one.
      // The round stays working; the next harness prompts it again.
      if (Exit.isFailure(prompted) || prompted.value !== undefined) {
        skip(next.harness, "not_confirmed")
        continue
      }
      yield* deps.show(h, row, terminal, root)
      return true
    }
  })

  /** The move with the platform services the session-scoped helpers need. */
  const rerun: LimitMove["rerun"] = (h, session, terminal, fallbackTask, ownsTerminal, error) =>
    rerunBody(h, session, terminal, fallbackTask, ownsTerminal, error).pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
      Effect.provideContext(deps.platform),
      Effect.orDie,
    )

  return { rerun }
}
