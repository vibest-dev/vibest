import { assert, describe, it } from "@effect/vitest"
import { Effect, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"

import { type Connection, type Pushed, RexError } from "../src/client.ts"
import { make } from "../src/terminal-runtime.ts"

const terminal = { id: "session:s/block:b" }

const processChanged = (name: string): Pushed => ({
  type: "event",
  payload: {
    type: "session_event",
    payload: {
      session_id: "session:s",
      event: {
        type: "block_event",
        payload: { block_id: "block:b", name: "process_changed", payload: { foreground: { name } } },
      },
    },
  },
})

describe("runtime-rex against a fake Rex connection", () => {
  it.effect("keeps following the local Rex server however long it stays away", () =>
    Effect.gen(function* () {
      let attempts = 0

      const runtime = yield* make({
        connect: Effect.suspend(() => {
          attempts++

          return Effect.fail(new RexError({ method: "connect", code: "unreachable", message: "no server" }))
        }),
        socket: "/nowhere/server.sock",
        scope: yield* Effect.scope,
        shell: "/bin/sh",
      })

      yield* runtime.process(terminal).pipe(Effect.flip)

      for (let i = 0; i < 40; i++) yield* TestClock.adjust("30 seconds")

      assert.isAbove(attempts, 30)
    }).pipe(Effect.scoped),
  )

  it.live("a program run types that exits while the Enter is still being sent leaves the shell idle", () =>
    Effect.gen(function* () {
      const pushed = yield* Queue.unbounded<Pushed>()

      const connection: Connection = {
        revision: 18,
        pushed: Stream.fromQueue(pushed),
        call: (method, payload) => {
          if (method === "session.attach_all") return Effect.succeed({ sessions: [] })

          if (method === "block.method") return Effect.succeed({ last_exit: null, foreground: { name: "zsh" } })

          const event = payload["event"]

          const released =
            method === "block.event" &&
            JSON.stringify(event).includes('"key":"enter"') &&
            JSON.stringify(event).includes('"action":"release"')

          return released
            ? Queue.offerAll(pushed, [processChanged("true"), processChanged("zsh")]).pipe(
                Effect.andThen(Effect.sleep("100 millis")),
                Effect.as({}),
              )
            : Effect.succeed({})
        },
      }

      const runtime = yield* make({
        connect: Effect.succeed(connection),
        socket: "/fake/server.sock",
        scope: yield* Effect.scope,
        shell: "/bin/sh",
      })

      yield* runtime.process(terminal)
      yield* Effect.sleep("100 millis")
      yield* runtime.run!(terminal, { argv: ["/usr/bin/true"], env: {} })

      assert.deepStrictEqual(yield* runtime.process(terminal), { running: false })
    }).pipe(Effect.scoped),
  )
})
