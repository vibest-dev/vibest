import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { envelope } from "@vibest/core/results"
import { NoSuchSession } from "@vibest/core/sessions"
import { Caller, Forbidden } from "@vibest/protocol/rpc"
import { Effect, Stream } from "effect"

import type { Handlers } from "./caller.ts"

export const make = Effect.gen(function* () {
  const db = yield* Db
  const inbox = yield* Inbox
  return {
    Report: ({ message }) =>
      Effect.gen(function* () {
        const owner = yield* Caller
        if (owner._tag !== "Session")
          return yield* new Forbidden({
            method: "Report",
            message: "only a session reports (vibest report runs with VIBEST_SESSION_ID)",
          })
        const session = yield* db.getSession(owner.sessionId)
        if (!session) return yield* new NoSuchSession({ id: owner.sessionId, message: `no session ${owner.sessionId}` })
        yield* inbox.enqueue({
          sessionId: session.id,
          kind: "report",
          message: envelope(
            "agent-message",
            [
              ["agent-id", session.id],
              ["summary", `Agent "${session.name}" sent a message before finishing`],
            ],
            ["message", message],
          ),
          details: {},
        })
      }),

    "Inbox.Subscribe": () =>
      Stream.unwrap(
        Effect.gen(function* () {
          const c = yield* Caller
          if (c._tag !== "Coordinator")
            return yield* new Forbidden({
              method: "Inbox.Subscribe",
              message: "Inbox.Subscribe is the coordinator's",
            })
          return inbox.stream(c.projectId)
        }),
      ),
  } satisfies Handlers
})
