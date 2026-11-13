import { assert, describe, it } from "@effect/vitest"
import { HerdrPool, type SessionEvent } from "@vibest/runtime-herdr/pool"
import * as TerminalRuntime from "@vibest/runtime-herdr/terminal-runtime"
import { fromPool } from "@vibest/runtime-herdr/terminal-runtime"
import { Cause, Deferred, Effect, Fiber, Logger, Queue, Stream } from "effect"
import { HerdrError, type HerdrShape, type PushFrame } from "effect-herdr-sdk"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

type Scripted = (method: string, params: Record<string, unknown>) => Effect.Effect<unknown, HerdrError>

const scriptedRuntime = (answer: Scripted, pushed: Stream.Stream<PushFrame> = Stream.empty) =>
  Effect.gen(function* () {
    const calls: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = []
    const resendingCall = ((method: string, params: Record<string, unknown>) =>
      Effect.suspend(() => {
        calls.push({ method, params })
        return answer(method, params)
      })) as HerdrShape["call"]
    const client: HerdrShape = {
      socketPath: "/nowhere",
      subscribe: () => pushed,
      call: resendingCall,
    }
    const resolved: Array<unknown> = []
    const pool = HerdrPool.of({
      resolve: (location) => Effect.sync(() => (resolved.push(location), "s")),
      client: () => Effect.succeed(client),
      events: Stream.empty,
      restarts: Stream.empty,
      sessions: Effect.succeed(["s"]),
    })
    const runtime = yield* fromPool({
      pool,
      spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
      fs: undefined,
      scope: yield* Effect.scope,
    })
    return { runtime, calls, resolved }
  })

const herdrError = (method: string, code: string) => Effect.fail(new HerdrError({ method, code, message: code }))

const scriptedSend = (agentNotReadyRefusals: number) =>
  Effect.gen(function* () {
    let refused = 0
    const { runtime, calls } = yield* scriptedRuntime((method) => {
      if (method === "agent.get")
        return Effect.succeed({
          agent: { name: "s-abcd1234abcd4abc8abcabcd1234ab", pane_id: "w1:p2", agent: "claude" },
        })
      if (method === "agent.prompt" && refused < agentNotReadyRefusals) {
        refused++
        return herdrError(method, "agent_not_ready")
      }
      return Effect.succeed({})
    })
    const sending = yield* Effect.forkChild(
      runtime.send(TerminalRuntime.terminalOf("s", "w1:p2", "s-abcd1234abcd4abc8abcabcd1234ab"), {
        text: "line one\nline two",
      }),
    )
    yield* TestClock.adjust("40 seconds")
    yield* Fiber.join(sending)
    return calls.map((c) => c.method).filter((m) => m !== "agent.get")
  }).pipe(Effect.provide(Platform.services))

describe("send to an agent herdr started", () => {
  it.effect("waits until herdr marks it ready, then prompts it: no text typed into a launch still pending", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* scriptedSend(3), ["agent.prompt", "agent.prompt", "agent.prompt", "agent.prompt"])
    }),
  )

  it.effect("herdr marks it ready only when it is read (agent.get), so each try reads it before agent.prompt", () =>
    Effect.gen(function* () {
      let ready = false
      let gets = 0
      const { runtime, calls } = yield* scriptedRuntime((method) => {
        if (method === "agent.get") {
          if (++gets > 2) ready = true
          return Effect.succeed({ agent: { name: "s-abcd1234abcd4abc8abcabcd1234ab", pane_id: "w1:p2", agent: "pi" } })
        }
        if (method === "agent.prompt" && !ready) return herdrError(method, "agent_not_ready")
        return Effect.succeed({})
      })
      const sending = yield* Effect.forkChild(
        runtime.send(TerminalRuntime.terminalOf("s", "w1:p2", "s-abcd1234abcd4abc8abcabcd1234ab"), { text: "task" }),
      )
      yield* TestClock.adjust("40 seconds")
      yield* Fiber.join(sending)
      const methods = calls.map((c) => c.method)
      assert.strictEqual(methods.filter((m) => m === "agent.prompt").length, 2)
      assert.notInclude(methods, "pane.send_input")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("an agent herdr never marks ready gets the text as one paste with Enter (pane.send_input)", () =>
    Effect.gen(function* () {
      const calls = yield* scriptedSend(Number.POSITIVE_INFINITY)
      assert.isAbove(calls.filter((m) => m === "agent.prompt").length, 1, "agent.prompt is retried before the paste")
      assert.strictEqual(calls.at(-1), "pane.send_input")
      assert.notInclude(calls, "pane.send_text")
    }),
  )
})

describe("pane events", () => {
  it.effect("a pane.agent_status_changed subscription frame (its data has no type) is a state event", () =>
    Effect.gen(function* () {
      const go = yield* Deferred.make<void>()
      const frame = {
        event: "pane.agent_status_changed",
        data: { pane_id: "w1:p2", workspace_id: "w1", agent: "pi", agent_status: "done" },
      } as PushFrame
      const { runtime } = yield* scriptedRuntime(
        () => Effect.succeed({}),
        Stream.fromEffect(Deferred.await(go)).pipe(Stream.as(frame)),
      )
      const first = yield* runtime.events!.pipe(Stream.take(2), Stream.runCollect, Effect.forkChild)
      const installPaneSubscription = runtime.state!(TerminalRuntime.terminalOf("s", "w1:p2")).pipe(Effect.ignore)
      yield* installPaneSubscription
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow
      yield* Deferred.succeed(go, undefined)
      assert.deepStrictEqual(yield* Fiber.join(first), [
        { type: "reset" },
        { type: "state", terminal: TerminalRuntime.terminalOf("s", "w1:p2"), state: "idle" },
      ])
    }).pipe(Effect.provide(Platform.services)),
  )
})

describe("terminal ids", () => {
  it("a terminal is `<session>/<pane>[/<name>]`, the parts non-empty, the agent name telling a pane id herdr reused apart; the caller's location is the machine target", () => {
    const terminal = TerminalRuntime.terminalOf("s1", "w1:p1")
    assert.deepStrictEqual(terminal, { id: "s1/w1:p1" })
    assert.deepStrictEqual(TerminalRuntime.parseTerminal(terminal), { session: "s1", paneId: "w1:p1", name: undefined })
    assert.deepStrictEqual(
      TerminalRuntime.parseTerminal(TerminalRuntime.terminalOf("s1", "w1:p1", "vbt-w1:p1-ab12cd34")),
      { session: "s1", paneId: "w1:p1", name: "vbt-w1:p1-ab12cd34" },
    )
    assert.isUndefined(TerminalRuntime.parseTerminal({ id: "/p" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ id: "s/" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ id: "pane" }))
    assert.isUndefined(TerminalRuntime.parseTerminal({ id: "s/p/" }))
    assert.deepStrictEqual(TerminalRuntime.decodeTarget(TerminalRuntime.encodeTarget({ session: "other" })), {
      session: "other",
    })
    assert.deepStrictEqual(TerminalRuntime.decodeTarget(TerminalRuntime.encodeTarget({ socketPath: "/h/s.sock" })), {
      socketPath: "/h/s.sock",
    })
    assert.isUndefined(TerminalRuntime.decodeTarget("{}"))
    assert.isUndefined(TerminalRuntime.decodeTarget(undefined))
  })
})

describe("herdr event stream", () => {
  it.effect("a failed herdr event stream is logged with its cause and emits reset", () => {
    const logs: Array<unknown> = []
    return Effect.gen(function* () {
      const open = yield* Deferred.make<void>()
      const pool = HerdrPool.of({
        resolve: () => Effect.succeed("s"),
        client: () => Effect.die("unused"),
        events: Stream.unwrap(
          Deferred.await(open).pipe(Effect.as(Stream.fail(new Error("socket closed")))),
        ) as unknown as Stream.Stream<SessionEvent>,
        restarts: Stream.empty,
        sessions: Effect.succeed([]),
      })
      const runtime = yield* fromPool({
        pool,
        spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
        fs: undefined,
        scope: yield* Effect.scope,
      })
      const seen = yield* Queue.unbounded<TerminalRuntime.RuntimeEvent>()
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(seen, event)),
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      assert.deepStrictEqual(yield* Queue.take(seen), { type: "reset" })
      yield* Deferred.succeed(open, undefined)
      assert.deepStrictEqual(yield* Queue.take(seen), { type: "reset" })
      assert.include(JSON.stringify(logs), "socket closed")
      assert.strictEqual(yield* Queue.size(seen), 0)
    }).pipe(
      Effect.provide(Platform.services),
      Effect.provide(
        Logger.layer([Logger.make((entry) => void logs.push([entry.message, Cause.pretty(entry.cause)]))]),
      ),
      Effect.scoped,
    )
  })
})
