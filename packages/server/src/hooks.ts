// A harness plugin's turn events, wherever they arrive (the RPC `TurnEnd` / `Prompt`, or the HTTP hook routes): vibestd
// keeps them in memory (TurnEnds) and tells Sessions, which writes them as events (runtime-port.md §5). No file.
import type { HarnessAdapter } from "@vibest/core/harness"
import { promptOf } from "@vibest/core/results"
import type { Sessions } from "@vibest/core/sessions"
import { turnEndOf } from "@vibest/core/turn-ends"
import { Clock, Effect } from "effect"

/** The calling session, already checked: its id and its agent (`coordinator` for a main agent). */
export type HookCaller = { readonly id: string; readonly agent: string }

/** The adapter's `turnEnd` reads `raw`; a turn end is handed to Sessions, which schedules a check. */
export const turnEnd = (sessions: Sessions["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const end = turnEndOf(adapter, who.agent, raw, yield* Clock.currentTimeMillis)
    if (end) yield* sessions.turnEnded(who.id, end)
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
