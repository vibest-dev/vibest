// A harness integration's neutral events (HTTP `/events`, or a shell-hook CLI's raw hook decoded by its adapter at
// `/hook`): vibestd keeps turn starts and ends in memory (TurnEnds, through Sessions), which writes them as events. No
// file. One code path for every harness, built-in or a plugin's.
import type { Db } from "@vibest/core/db"
import type { Inbox } from "@vibest/core/inbox"
import type { Sessions } from "@vibest/core/sessions"
import { turnEndOf } from "@vibest/core/turn-ends"
import type { IntegrationEvent } from "@vibest/protocol/protocol"
import { Clock, Effect, Schema } from "effect"

/** The calling session, already checked: its id, its agent (`coordinator` for a main agent) and its harness. */
export type HookCaller = {
  readonly id: string
  readonly agent: string
  /** Its project's entry session (the main agent): its inbox is the project's, and its turns are no one's round. */
  readonly entry: boolean
  readonly harness: string
  readonly projectId: number
}

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
export const apply = (
  db: Db["Service"],
  sessions: Sessions["Service"],
  inbox: Inbox["Service"],
  who: HookCaller,
  event: IntegrationEvent,
) =>
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
        // The rows this turn took (a polling integration names them): delivered, bound to the turn.
        if (event.inbox !== undefined && event.inbox.length > 0) {
          if (who.entry) yield* inbox.ack(who.projectId, event.inbox)
          else yield* sessions.consumed(who.id, event.inbox)
        }
        if (who.entry) return
        if (event.origin === "typed" && event.text.trim() !== "") {
          // One stamp, taken now: `userPrompt` notes the start at once (before it may wait for the session's lock, held
          // through a send's whole confirm) and stamps the round with the same time.
          yield* sessions.userPrompt(who.id, event.text, yield* Clock.currentTimeMillis)
        }
        // The harness works on its open round: the pickup proof, and its status.
        yield* sessions.activity(who.id, "working")
        return
      }
      case "turn.end": {
        if (who.entry) return
        yield* sessions.turnEnded(who.id, turnEndOf(who.harness, event, yield* Clock.currentTimeMillis))
        return
      }
      case "blocked":
        if (who.entry) return
        yield* Effect.logInfo(`session ${who.id} is blocked on a ${event.reason}`)
        yield* sessions.activity(who.id, { blocked: event.reason })
    }
  })
