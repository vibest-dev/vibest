import type * as VibestPlugin from "@vibest/plugin"
import { exhaustedText, isLimited, stillLimited } from "@vibest/plugin"
import type { ProcessEndReason } from "@vibest/schema/event"
import { newId } from "@vibest/schema/id"
import type { Subscription } from "@vibest/schema/subscription"
import { Cause, Clock, Context, Effect, Exit, Layer } from "effect"

import { Db, type SessionRow } from "../db.ts"
import { LayerNode } from "../effect/layer-node.ts"
import { Harness, harnessOptions, Harnesses, preflight } from "../harness.ts"
import { errorMessage, Plugins } from "../plugins.ts"
import { Processes } from "../processes.ts"
import { RuntimeError, type Runtime, type Terminal } from "../runtimes.ts"
import { Subscriptions } from "../subscriptions/service.ts"
import { Executions } from "./executions.ts"
import { Placement } from "./placement.ts"

export interface LimitMove {
  readonly rerun: (
    h: Runtime,
    session: SessionRow,
    terminal: Terminal | undefined,
    fallbackTask: string,
    ownsTerminal: boolean,
    error: string,
    limited: number,
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

const make = Effect.gen(function* () {
  const db = yield* Db
  const plugins = yield* Plugins
  const subscriptions = yield* Subscriptions
  const harness = yield* Harness
  const harnesses = yield* Harnesses
  const processes = yield* Processes
  const { prompt, finish } = yield* Executions
  const { openTerminal, show, locate, launchArgv, systemPromptOf } = yield* Placement

  const exited = (id: string, reason: ProcessEndReason) =>
    Effect.andThen(db.setStatus(id, "unknown"), db.endProcess(id, reason))

  const rerunBody = Effect.fn("Move.rerun")(function* (
    h: Runtime,
    session: SessionRow,
    current: Terminal | undefined,
    fallbackTask: string,
    ownsTerminal: boolean,
    error: string,
    limited: number,
  ) {
    const newerExecution = Effect.map(db.limitSource(session.id, limited), (fresh) => fresh === undefined)
    const source = yield* db.limitSource(session.id, limited)
    if (source === undefined) return true
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
      const sent = pid === undefined ? "gone" : yield* processes.terminate(pid)
      if (sent !== "denied") {
        yield* db.endProcess(row.id, limitedEnded ? "move" : "limited")
        limitedEnded = true
        running = "none"
      }
      return sent
    })
    const at = yield* Clock.currentTimeMillis
    const stored = yield* db.attempts(session.id)
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
          yield* finish(fresh, "failed", why)
          if (running === "none") yield* exited(fresh.id, limitedEnded ? "move" : "limited")
          return false
        }
        if (!(owns && terminal)) {
          yield* finish(fresh, "failed", why)
          return false
        }
        const closed = yield* h.close(terminal).pipe(Effect.exit)
        if (Exit.isFailure(closed)) {
          yield* finish(
            fresh,
            "failed",
            `${fresh.id} stopped after a usage limit, but closing its terminal failed (${errorMessage(closed.cause)})`,
          )
          return false
        }
        yield* finish(fresh, "failed", why)
        yield* exited(fresh.id, limitedEnded ? "move" : "limited")
        return false
      })
    const options = yield* harnessOptions.pipe(
      Effect.provideService(Harness, harness),
      Effect.provideService(Harnesses, harnesses),
    )
    const thisExecution = [
      ...(yield* db.limitedSince(session.id, source.since)).map((l) => ({
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
      if (thisExecution.some((l) => l.harness === move.harness && l.provider === provider)) return true
      return attempts().some(
        (a) =>
          a.harness === move.harness &&
          (a.outcome !== "limited" || a.provider === undefined || (a.provider === provider && stillLimited(a, rows))),
      )
    }
    const { root, cwd } = yield* locate(session)
    const base = {
      project: root,
      agent: session.agent,
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
          input: task,
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
      if (!limitedEnded && (yield* newerExecution)) return true
      if (inPlace) {
        if ((yield* endRunning) === "denied") {
          yield* finish(row, "failed", `${row.id} stayed on ${row.harnessId}: SIGTERM to its harness was refused`)
          return false
        }
      } else if (terminal !== undefined) {
        const closed = yield* h.close(terminal).pipe(Effect.exit)
        if (Exit.isFailure(closed)) {
          yield* finish(
            row,
            "failed",
            `${row.id} stayed on ${row.harnessId}: closing its terminal failed (${errorMessage(closed.cause)})`,
          )
          return false
        }
        terminal = undefined
        owns = false
        gone = true
        yield* endLeft
      } else yield* endLeft
      const harnessSessionId = (yield* harnesses.get(next.harness)).ownSessionId ? yield* newId() : null
      const nextRow: SessionRow = {
        ...row,
        harnessId: next.harness,
        provider: next.provider ?? null,
        model: next.model ?? null,
        harnessSessionId,
      }
      const argv = yield* launchArgv(nextRow, false)
      if (inPlace)
        yield* db.updateSession(row.id, {
          harnessId: next.harness,
          provider: next.provider ?? null,
          model: next.model ?? null,
          harnessSessionId,
        })
      const placed = inPlace
        ? yield* h.run!(terminal!, argv).pipe(Effect.as(terminal!), Effect.exit)
        : yield* openTerminal(h, undefined, nextRow, { project: root, cwd, argv }).pipe(Effect.exit)
      if (Exit.isFailure(placed)) {
        const failed = Cause.squash(placed.cause)
        const startDeath = failed instanceof RuntimeError && failed.code === "failed"
        if (!startDeath) {
          yield* finish(
            row,
            "failed",
            `${row.id} stopped after a usage limit, but placing the next pane failed (${errorMessage(placed.cause)})`,
          )
          if (gone || inPlace) yield* exited(row.id, "move")
          return false
        }
        skip(next.harness, "start_failed")
        continue
      }
      terminal = placed.value
      if (inPlace) running = "mine"
      else owns = true
      row = (yield* db.getSession(row.id))!
      const text = (yield* harnesses.get(row.harnessId)).systemPromptInPrompt
        ? `${yield* systemPromptOf(row)}\n\n# Task\n\n${next.prompt}`
        : next.prompt
      const prompted = yield* prompt(h, row, terminal, text, db.linkTask(row.id)).pipe(Effect.exit)
      if (Exit.isFailure(prompted) || prompted.value !== undefined) {
        skip(next.harness, "not_confirmed")
        continue
      }
      yield* show(h, row, terminal, root)
      return true
    }
  })

  const rerun: LimitMove["rerun"] = (h, session, terminal, fallbackTask, ownsTerminal, error, limited) =>
    rerunBody(h, session, terminal, fallbackTask, ownsTerminal, error, limited).pipe(Effect.orDie)

  return { rerun }
})

export class Move extends Context.Service<Move, Effect.Success<typeof make>>()("vibest/Move") {
  static readonly make = make

  static readonly layer = Layer.effect(Move, make)

  static readonly node = LayerNode.make({
    service: Move,
    layer: Move.layer,
    deps: [
      Db.node,
      Executions.node,
      Harness.node,
      Harnesses.node,
      Placement.node,
      Plugins.node,
      Processes.node,
      Subscriptions.node,
    ],
  })
}
