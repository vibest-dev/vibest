import { Inbox } from "@vibest/core/inbox"
import { Caller, Forbidden } from "@vibest/protocol/rpc"
import { Effect, Stream } from "effect"

import { processOf, reader } from "../gates.ts"
import type { Handlers } from "./caller.ts"

export const make = Effect.gen(function* () {
  const inbox = yield* Inbox.Service
  const pullingSession = (method: "Inbox.Subscribe" | "Inbox.Take") =>
    Effect.gen(function* () {
      const c = yield* Caller
      if (c._tag !== "Session") return yield* new Forbidden({ method, message: `${method} is a session's own` })
      return c.sessionId
    })
  return {
    "Inbox.Subscribe": () => Stream.unwrap(Effect.map(pullingSession("Inbox.Subscribe"), inbox.stream)),
    "Inbox.Take": (_payload, { headers }) =>
      Effect.flatMap(pullingSession("Inbox.Take"), (sessionId) =>
        inbox.take(sessionId, processOf(reader(headers))).pipe(Effect.map((taken) => taken ?? null)),
      ),
  } satisfies Handlers
})
