import type * as VibestPlugin from "@vibest/plugin"
import { exhaustedText, isLimited, stillLimited } from "@vibest/plugin"
import type { Subscription } from "@vibest/schema/subscription"
import { Cause, Clock, Context, Crypto, Effect, Exit, FileSystem, Path } from "effect"
import { ChildProcessSpawner } from "effect/process"

import type { Db, SessionRow } from "./db.ts"
import type { Git } from "./git.ts"
import { Harness, harnessOptions, Harnesses, preflight } from "./harness.ts"
import { errorMessage, type Plugins } from "./plugins.ts"
import { RuntimeError } from "./runtimes.ts"
import { type Machine, type Runtime, type Terminal } from "./runtimes.ts"
import type { Subscriptions } from "./subscriptions/service.ts"

export type MovePlatform =
  | FileSystem.FileSystem
  | Path.Path
  | Crypto.Crypto
  | ChildProcessSpawner.ChildProcessSpawner
  | Git

export interface LimitMove {
  readonly rerun: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal | undefined,
    fallbackTask: string,
    ownsTerminal: boolean,
    error: string,
  ) => Effect.Effect<boolean>
}

const limitFailure = (
  rows: ReadonlyArray<Subscription>,
  harness: string,
  provider: string | undefined,
  error: string,
) => {
  const text = rows
    .filter((row) => row.harness === harness && (provider === undefined || row.provider === provider) && isLimited(row))
    .map((row) => {
      const who = row.provider === "" ? harness : `${harness}/${row.provider}`
      return `${who}: ${exhaustedText(row.limits)}`
    })
    .join("; ")
  const named = provider === undefined || provider === "" ? harness : `${harness}/${provider}`
  return text === "" ? `${named}: ${error}` : text
}

export const limitMoveBox = (): {
  readonly move: {
    rerun: LimitMove["rerun"]
  }
} => ({ move: { rerun: () => Effect.die("limit move not wired") as Effect.Effect<boolean> } })

export const sessionMove = (deps: {
  readonly db: Pick<
    Db["Service"],
    "getSession" | "updateSession" | "rescheduleSource" | "endProcess" | "linkTask" | "latestRoundAt" | "limitedSince"
  >
  readonly plugins: Plugins["Service"]
  readonly subscriptions: Subscriptions["Service"]
  readonly harness: Harness["Service"]
  readonly harnesses: Harnesses["Service"]
  readonly track: (id: string) => Effect.Effect<{ readonly sawWorking: import("effect").Ref.Ref<boolean> }>
  readonly prompt: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    text: string,
    onHandover?: Effect.Effect<void>,
    options?: { readonly keepRound?: boolean },
  ) => Effect.Effect<string | undefined, unknown, MovePlatform>
  readonly open: (
    h: Runtime,
    machine: Machine,
    session: SessionRow,
    input: {
      readonly project: string
      readonly cwd: string
      readonly argv: ReadonlyArray<string>
      readonly near?: Terminal | undefined
    },
  ) => Effect.Effect<Terminal, unknown, MovePlatform>
  readonly show: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal,
    root: string,
  ) => Effect.Effect<void, unknown, MovePlatform>
  readonly locate: (
    session: SessionRow,
  ) => Effect.Effect<{ readonly root: string; readonly cwd: string }, unknown, MovePlatform>
  readonly launchArgv: (
    session: SessionRow,
    resume: boolean,
  ) => Effect.Effect<ReadonlyArray<string>, unknown, MovePlatform>
  readonly finish: (
    session: SessionRow,
    end: "failed",
    text: string,
    error: string | undefined,
  ) => Effect.Effect<unknown, unknown, MovePlatform>
  readonly systemPromptOf: (session: SessionRow) => Effect.Effect<string, unknown, MovePlatform>
  readonly uuid: Effect.Effect<string>
  readonly terminate: (pid: number) => Effect.Effect<"sent" | "gone" | "denied">
  readonly platform: Context.Context<MovePlatform>
}) => {
  const { db, plugins, subscriptions, harness, harnesses } = deps

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
    let gone = false
    const inPlace = current !== undefined && h.run !== undefined && session.metadata.pid !== undefined
    let running: "old" | "mine" | "none" = "old"
    const endRunning = Effect.gen(function* () {
      if (running === "none") return "sent" as const
      const pid = ((yield* db.getSession(row.id)) ?? row).metadata.pid
      const sent = pid === undefined ? "gone" : yield* deps.terminate(pid)
      if (sent !== "denied") {
        yield* db.endProcess(row.id, limitedEnded ? "move" : "limited")
        limitedEnded = true
        running = "none"
      }
      return sent
    })
    const at = yield* Clock.currentTimeMillis
    const stored = session.metadata.attempts ?? []
    const provider = session.provider ?? undefined
    const recorded = stored.some((a) => a.harness === session.harnessId && a.provider === provider)
      ? stored
      : [...stored, { harness: session.harnessId, provider, outcome: "limited" as const, at }]
    let limitedEnded = false
    const endLeft = Effect.gen(function* () {
      yield* db.endProcess(row.id, limitedEnded ? "move" : "limited")
      limitedEnded = true
    })
    const skipped: Array<VibestPlugin.Attempt> = []
    const skip = (harness: string, outcome: Exclude<VibestPlugin.Attempt["outcome"], "limited">) => {
      if (!skipped.some((a) => a.harness === harness)) skipped.push({ harness, provider: undefined, outcome, at })
    }
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
    const giveUp = (why: string) =>
      Effect.gen(function* () {
        const fresh = (yield* db.getSession(row.id)) ?? row
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
    const roundStart = (yield* db.latestRoundAt(session.id)) ?? 0
    const thisRound = [
      ...(yield* db.limitedSince(session.id, roundStart)).map((l) => ({
        harness: l.harness,
        provider: l.provider ?? "",
      })),
      { harness: session.harnessId, provider: provider ?? "" },
    ]
    const ruledOut = (
      move: { harness: string | undefined; provider?: string | undefined } | undefined,
      rows: ReadonlyArray<Subscription>,
    ) => {
      if (move === undefined || harnesses.find(move.harness) === undefined) return true
      const provider = move.provider ?? ""
      if (thisRound.some((l) => l.harness === move.harness && l.provider === provider)) return true
      return attempts().some(
        (a) =>
          a.harness === move.harness &&
          (a.outcome !== "limited" || a.provider === undefined || (a.provider === provider && stillLimited(a, rows))),
      )
    }
    const { root, cwd } = yield* deps.locate(session)
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
      if (decided.value.move === undefined) {
        const why = limitFailure(rows, row.harnessId, row.provider ?? undefined, error)
        const tried =
          skipped.length === 0
            ? ""
            : `; ${skipped.map((attempt) => attempt.harness).join(", ")} tried and did not start`
        return yield* giveUp(`${why}${tried}`)
      }
      if (ruledOut(decided.value.move, rows)) return yield* giveUp(yield* left())
      const move = decided.value.move!
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
      if (next === undefined || next.harness === undefined || harnesses.find(next.harness) === undefined) {
        skip(move.harness, "refused")
        continue
      }
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
      if (inPlace) {
        if ((yield* endRunning) === "denied") {
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
      const harnessSessionId = harnesses.get(next.harness).ownSessionId ? yield* deps.uuid : null
      const nextRow: SessionRow = {
        ...row,
        harnessId: next.harness,
        provider: next.provider ?? null,
        model: next.model ?? null,
        harnessSessionId,
      }
      const argv = yield* deps.launchArgv(nextRow, false)
      if (inPlace)
        yield* db.updateSession(row.id, {
          harnessId: next.harness,
          provider: next.provider ?? null,
          model: next.model ?? null,
          harnessSessionId,
        })
      const placed = inPlace
        ? yield* h.run!(terminal!, argv).pipe(Effect.as(terminal!), Effect.exit)
        : yield* deps.open(h, machine, nextRow, { project: root, cwd, argv }).pipe(Effect.exit)
      if (Exit.isFailure(placed)) {
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
      const text = harnesses.get(row.harnessId).systemPromptInPrompt
        ? `${yield* deps.systemPromptOf(row)}\n\n# Task\n\n${next.prompt}`
        : next.prompt
      const prompted = yield* deps
        .prompt(h, row, terminal, text, db.linkTask(row.id), { keepRound: true })
        .pipe(Effect.exit)
      if (Exit.isFailure(prompted) || prompted.value !== undefined) {
        skip(next.harness, "not_confirmed")
        continue
      }
      yield* deps.show(h, row, terminal, root)
      return true
    }
  })

  const rerun: LimitMove["rerun"] = (h, session, terminal, fallbackTask, ownsTerminal, error) =>
    rerunBody(h, session, terminal, fallbackTask, ownsTerminal, error).pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
      Effect.provideContext(deps.platform),
      Effect.orDie,
    )

  return { rerun }
}
