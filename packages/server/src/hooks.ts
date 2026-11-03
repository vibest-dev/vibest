// A harness plugin's turn events, wherever they arrive (the RPC `TurnEnd` / `Prompt`, or the HTTP hook routes): vibestd
// alone writes the result file and the report lines (runtime-port.md §5), then tells Sessions.
import type { HarnessAdapter } from "@vibest/core/harness"
import { promptOf, recordPrompt, recordTurnEnd } from "@vibest/core/results"
import type { Sessions } from "@vibest/core/sessions"
import { Clock, Effect } from "effect"

/** The calling session, already checked: its id and its agent (`coordinator` for a main agent). */
export type HookCaller = { readonly id: string; readonly agent: string }

/** The adapter's `turnEnd` reads `raw`; a result writes the result file and its report line, and schedules a check. */
export const turnEnd = (sessions: Sessions["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    if (yield* recordTurnEnd(adapter, who.agent, who.id, raw)) yield* sessions.resultReady(who.id)
  })

/**
 * The adapter's `userPrompt` reads `raw`; the user's text writes the turn-start line and records the round. One stamp,
 * taken now: the start line is written at once, and `userPrompt` (which may wait for the session's lock, held through
 * a send's whole confirm) stamps the round with the same time, so the line is never older than it and the pending
 * send sees its pickup proof while it still waits.
 */
export const prompt = (sessions: Sessions["Service"], adapter: HarnessAdapter, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const text = promptOf(adapter, who.agent, raw)
    if (text === undefined) return
    const at = yield* Clock.currentTimeMillis
    yield* recordPrompt(who.id, text, at)
    yield* sessions.userPrompt(who.id, text, at)
  })
