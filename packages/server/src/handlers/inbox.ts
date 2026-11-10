import { Inbox } from "@vibest/core/inbox"
import { Caller, Forbidden } from "@vibest/protocol/rpc"
import { Effect, Stream } from "effect"

import type { Handlers } from "./caller.ts"

export const make = Effect.gen(function* () {
  const inbox = yield* Inbox
  return {
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
