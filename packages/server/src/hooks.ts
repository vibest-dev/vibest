import type { Db } from "@vibest/core/db"
import type { HarnessDefinition } from "@vibest/core/host"
import { jsonObject, promptOf, turnEndOf } from "@vibest/core/results"
import type { Sessions } from "@vibest/core/sessions"
import { Clock, Effect } from "effect"

export type HookCaller = { readonly id: string; readonly agent: string }

const noteEventConversation = (db: Db["Service"], definition: HarnessDefinition, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    const event = definition.conversationOf === undefined ? undefined : jsonObject(raw)
    const conversation = event && definition.conversationOf?.(event)
    if (conversation && (yield* db.noteHarnessSession(who.id, conversation)))
      yield* Effect.logInfo(`session ${who.id} is in conversation ${conversation}`)
  })

export const turnEnd = (db: Db["Service"], definition: HarnessDefinition, who: HookCaller, raw: string) =>
  Effect.gen(function* () {
    yield* noteEventConversation(db, definition, who, raw)
    const end = turnEndOf(definition, who.agent, raw, yield* Clock.currentTimeMillis)
    if (!end) return
    yield* db.reportTurn(who.id, end)
    yield* db.updateSession(who.id, { status: "idle" })
    yield* Effect.log(`turn end ${who.id} (${end.harness}${end.interrupted ? ", interrupted" : ""})`)
  })

export const prompt = (
  sessions: Sessions["Service"],
  db: Db["Service"],
  definition: HarnessDefinition,
  who: HookCaller,
  raw: string,
) =>
  Effect.gen(function* () {
    yield* noteEventConversation(db, definition, who, raw)
    const text = promptOf(definition, who.agent, raw)
    if (text === undefined) return
    yield* sessions.userPrompt(who.id, text, yield* Clock.currentTimeMillis)
  })
