import { assert, it } from "@effect/vitest"
import { SessionStore } from "@vibest/core/session/store"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { projectOf } from "@vibest/testkit/fakes"
import { database, place, session } from "@vibest/testkit/unit-helpers"
import { Effect } from "effect"

it.effect("a session row's open execution is the newest one and its last execution the one that ended before", () =>
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore.Service
    const project = yield* projectOf("r")
    const child = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const parent = (yield* sessionStore.startRoot(project, "pi", false, place, { agent: "coordinator" })).sessionId
    yield* sessionStore.insertSession(session(child, { terminal: null }), project, {
      parentSessionId: parent,
    })
    yield* sessionStore.placeProcess(child, { id: "t1" }, 42)
    const first = (yield* sessionStore.startExecution(child, 5)).execution
    yield* sessionStore.endExecution(
      child,
      { outcome: "failed", failure: { message: "rate_limit", kind: "limit" } },
      undefined,
      9,
    )
    const second = (yield* sessionStore.startExecution(child, 12)).execution
    const row = (yield* sessionStore.getSession(child))!
    assert.strictEqual(row.openExecution!.id, second)
    assert.deepInclude(row.lastExecution!, { id: first, outcome: "failed" })
  }).pipe(Effect.provide(database(":memory:"))),
)

it.effect("processesAt binds the live processes at that runtime and terminal", () =>
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore.Service
    const project = yield* projectOf("r")
    const here = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const terminal = { id: "pane-a" }
    yield* sessionStore.insertSession(
      session("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", {
        terminal: { id: "pane-b" },
        createdAt: 0,
      }),
      project,
    )
    yield* sessionStore.insertSession(
      session("cccccccc-cccc-4ccc-8ccc-cccccccccccc", { runtime: "other", terminal, createdAt: 0 }),
      project,
    )
    yield* sessionStore.insertSession(
      session("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", { terminal, exitedAt: 5, createdAt: 0 }),
      project,
    )
    yield* sessionStore.insertSession(session(here, { terminal, createdAt: 1 }), project)
    const bound = yield* sessionStore.processesAt(RUNTIME, terminal)
    assert.deepStrictEqual(
      bound.map((p) => p.sessionId),
      [here],
    )
    assert.strictEqual(bound[0]!.process, (yield* sessionStore.getSession(here))!.process!.id)
    assert.deepStrictEqual(yield* sessionStore.processesAt(RUNTIME, { id: "missing" }), [])
  }).pipe(Effect.provide(database(":memory:"))),
)
