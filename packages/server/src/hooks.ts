// A harness plugin's turn events, wherever they arrive (the RPC `TurnEnd` / `Prompt`, or the HTTP hook routes): a turn
// end is one `turn.reported` event (no session lock; a settlement while draining); Sessions checks it on that event.
import type { Db } from "@vibest/core/db"
import type { HarnessAdapter } from "@vibest/core/harness"
import { promptOf } from "@vibest/core/results"
import type { Sessions } from "@vibest/core/sessions"
import { turnEndOf } from "@vibest/core/turn-ends"
import { Clock, Effect } from "effect"

/** The calling session, already checked: its id and its agent (`coordinator` for a main agent). */
export type HookCaller = { readonly id: string; readonly agent: string }

/** The adapter's `turnEnd` reads `raw`; the report is stored, and its event makes Sessions check the session. */
export const turnEnd = (db: Db["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const end = turnEndOf(adapter, who.agent, raw, yield* Clock.currentTimeMillis)
    if (!end) return
    yield* db.reportTurn(who.id, end)
    // One line per reported end (no text): what vibestd.log shows of a turn end that writes no result.
    yield* Effect.log(`turn end ${who.id} (${end.harness}${end.interrupted ? ", interrupted" : ""})`)
  })

/**
 * The adapter's `userPrompt` reads `raw`; the user's text is the turn start, and records the round. One stamp, taken
 * now: `userPrompt` notes the start at once (before it may wait for the session's lock, held through a send's whole
 * confirm) and stamps the round with the same time, so the pending send sees its pickup proof while it still waits.
 */
export const prompt = (sessions: Sessions["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const text = promptOf(adapter, who.agent, raw)
    if (text === undefined) return
    yield* sessions.userPrompt(who.id, text, yield* Clock.currentTimeMillis)
  })
