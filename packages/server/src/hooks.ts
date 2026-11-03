// A harness integration's neutral events (HTTP `/events`, or a shell-hook CLI's raw hook decoded by its adapter at
// `/hook`): vibestd alone writes what they say (the session's events, result file and report lines), then tells Sessions.
// One code path for every harness, built-in or a plugin's.
import type { Db } from "@vibest/core/db"
import { recordPrompt, recordTurnEnd } from "@vibest/core/results"
import type { Sessions } from "@vibest/core/sessions"
import type { IntegrationEvent } from "@vibest/protocol/protocol"
import { Clock, Effect, Schema } from "effect"

/** The calling session, already checked: its id, its agent (`coordinator` for a main agent) and its harness. */
export type HookCaller = { readonly id: string; readonly agent: string; readonly harness: string }

const Failure = Schema.Struct({ kind: Schema.Literals(["limited", "auth", "other"]), message: Schema.String })

/** `IntegrationEvent` on the wire. */
export const IntegrationEventSchema = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("ready"),
    pid: Schema.optionalKey(Schema.Int),
    conversation: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("conversation"), conversation: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("turn.start"),
    origin: Schema.Literals(["typed", "inbox"]),
    text: Schema.String,
    inbox: Schema.optionalKey(Schema.Array(Schema.Number)),
  }),
  Schema.Struct({
    type: Schema.Literal("turn.end"),
    outcome: Schema.Literals(["completed", "failed", "interrupted"]),
    text: Schema.optionalKey(Schema.String),
    failure: Schema.optionalKey(Failure),
  }),
  Schema.Struct({
    type: Schema.Literal("blocked"),
    reason: Schema.Literals(["permission", "question"]),
    detail: Schema.optionalKey(Schema.String),
  }),
])

/** `ToolCall` on the wire. */
export const ToolCallSchema = Schema.Struct({
  kind: Schema.Literals(["shell", "edit", "read", "search", "other"]),
  name: Schema.String,
  command: Schema.optionalKey(Schema.String),
  paths: Schema.Array(Schema.String),
  cwd: Schema.String,
})

/**
 * One event of `who`. The main agent's turns are no result and no round (its turns are opened by the person or by
 * results); a typed turn start opens a round for any other session (the user typed into its pane).
 */
export const apply = (db: Db["Service"], sessions: Sessions["Service"], who: HookCaller, event: IntegrationEvent) =>
  Effect.gen(function* () {
    switch (event.type) {
      case "ready": {
        yield* db.patchLive(who.id, {
          ready: yield* Clock.currentTimeMillis,
          ...(event.pid === undefined ? {} : { pid: event.pid }),
        })
        if (event.conversation) yield* db.noteHarnessSession(who.id, event.conversation)
        return
      }
      case "conversation": {
        if (yield* db.noteHarnessSession(who.id, event.conversation))
          yield* Effect.logInfo(`session ${who.id} is in conversation ${event.conversation}`)
        return
      }
      case "turn.start": {
        if (event.origin !== "typed" || who.agent === "coordinator" || event.text.trim() === "") return
        // One stamp, taken now: the start line is written at once, and `userPrompt` (which may wait for the session's
        // lock, held through a send's whole confirm) stamps the round with the same time.
        const at = yield* Clock.currentTimeMillis
        yield* recordPrompt(who.id, event.text, at)
        yield* sessions.userPrompt(who.id, event.text, at)
        return
      }
      case "turn.end": {
        if (who.agent === "coordinator") return
        if (yield* recordTurnEnd(who.harness, who.id, event)) yield* sessions.resultReady(who.id)
        return
      }
      case "blocked":
        yield* Effect.logInfo(`session ${who.id} is blocked on a ${event.reason}`)
    }
  })
