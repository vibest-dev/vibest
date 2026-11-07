import type { Db } from "@vibest/core/db"
import type { HarnessAdapter } from "@vibest/core/harness"
import { promptOf, turnEndOf } from "@vibest/core/results"
import type { Sessions } from "@vibest/core/sessions"
import { Clock, Effect } from "effect"

export type HookCaller = { readonly id: string; readonly agent: string }

export const turnEnd = (db: Db["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const end = turnEndOf(adapter, who.agent, raw, yield* Clock.currentTimeMillis)
    if (!end) return
    yield* db.reportTurn(who.id, end)
    yield* db.updateSession(who.id, { status: "idle" })
    yield* Effect.log(`turn end ${who.id} (${end.harness}${end.interrupted ? ", interrupted" : ""})`)
  })

export const prompt = (sessions: Sessions["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const text = promptOf(adapter, who.agent, raw)
    if (text === undefined) return
    yield* sessions.userPrompt(who.id, text, yield* Clock.currentTimeMillis)
  })
