import { assert, describe, it } from "@effect/vitest"
import { callerKeys, detectCaller, selectCaller, type Candidate } from "@vibest/core/caller-runtime"
import { Processes, type ProcessFacts } from "@vibest/core/processes"
import { RuntimeError } from "@vibest/core/runtimes"
import { Effect } from "effect"

import { inspect, linuxFacts } from "../src/platform/process-facts.ts"
import { FakeRuntime, testLayer } from "./fakes.ts"

const candidate = (runtime: string, localRootPid: number, live = true): Candidate => ({
  runtime,
  terminal: { machine: "local", id: runtime + "-terminal" },
  live,
  localRootPid,
})
const processAt = (pid: number, parent: number, tty?: string, session?: string): ProcessFacts => ({
  pid,
  parent,
  tty,
  session,
  start: String(pid),
  namespace: "local",
})
const pick = (candidates: ReadonlyArray<Candidate>, facts: ReadonlyArray<ProcessFacts>) =>
  selectCaller(50, candidates, facts)
const matched = (runtime: string) => ({
  status: "matched" as const,
  runtime,
  terminal: { machine: "local", id: runtime + "-terminal" },
})

describe("caller terminal membership", () => {
  for (const [inner, outer] of [
    ["hc", "herdr"],
    ["herdr", "hc"],
    ["third-party", "other"],
  ]) {
    it(inner + " inside " + outer + ": tty wins even when the daemon root is not an ancestor", () => {
      assert.deepStrictEqual(
        pick(
          [candidate(outer!, 10), candidate(inner!, 20)],
          [
            processAt(50, 40, "inner", "20"),
            processAt(40, 10),
            processAt(10, 1, "outer", "10"),
            processAt(20, 1, "inner", "20"),
          ],
        ),
        matched(inner!),
      )
    })
    it(inner + " inside " + outer + ": nearest root wins without tty metadata", () => {
      assert.deepStrictEqual(
        pick(
          [candidate(outer!, 10), candidate(inner!, 20)],
          [processAt(50, 40), processAt(40, 20), processAt(20, 10), processAt(10, 1)],
        ),
        matched(inner!),
      )
    })
  }
  it("session match works with redirected stdio; an unrelated live environment is not adopted", () => {
    const candidates = [candidate("inside", 20), candidate("stale", 10)]
    assert.deepStrictEqual(
      pick(candidates, [
        processAt(50, 40, undefined, "20"),
        processAt(20, 1, undefined, "20"),
        processAt(10, 1, undefined, "10"),
      ]),
      matched("inside"),
    )
    assert.strictEqual(
      pick([candidate("stale", 10)], [processAt(50, 1, "new"), processAt(10, 1, "old")]).status,
      "unresolved",
    )
  })
  it("drops finished terminals and dead roots; keeps live idle shells", () => {
    assert.deepStrictEqual(
      pick(
        [candidate("finished", 10, false), candidate("dead", 30), candidate("idle", 20)],
        [processAt(50, 20), processAt(20, 1), processAt(10, 1)],
      ),
      matched("idle"),
    )
  })
  it("includes the caller itself and refuses a known new PTY boundary", () => {
    assert.deepStrictEqual(pick([candidate("exec", 50)], [processAt(50, 1)]), matched("exec"))
    assert.strictEqual(
      pick([candidate("outer", 10)], [processAt(50, 10, "tmux"), processAt(10, 1, "outer")]).status,
      "unresolved",
    )
  })
  it("refuses ambiguous tty and ancestor claims, missing metadata and foreign namespaces", () => {
    assert.strictEqual(
      pick(
        [candidate("a", 10), candidate("b", 20)],
        [processAt(50, 10, "tty"), processAt(10, 1, "tty"), processAt(20, 1, "tty")],
      ).status,
      "unresolved",
    )
    assert.strictEqual(
      pick([candidate("a", 10), candidate("b", 10)], [processAt(50, 10), processAt(10, 1)]).status,
      "unresolved",
    )
    assert.strictEqual(pick([candidate("a", 10)], []).status, "unresolved")
    assert.strictEqual(
      pick([candidate("a", 10)], [processAt(50, 10, "tty"), { ...processAt(10, 1, "tty"), namespace: "foreign" }])
        .status,
      "unresolved",
    )
  })
  it("bounds cyclic and broken ancestry", () => {
    assert.strictEqual(
      pick([candidate("a", 10)], [processAt(50, 40), processAt(40, 50), processAt(10, 1)]).status,
      "unresolved",
    )
  })
})

describe("platform process facts", () => {
  it("reads the actual caller, not ps or stdin", async () => {
    const facts = await inspect(process.pid)
    assert.strictEqual(facts?.pid, process.pid)
    assert.strictEqual(facts?.parent, process.ppid)
    assert.isNotEmpty(facts?.start)
  })
  it("parses Linux comm with spaces and parentheses and rejects zombie roots", () => {
    const stat = "50 (shell (nested)) S 20 50 20 123 0 0 0 0 0 0 0 0 0 0 0 0 0 0 456"
    assert.deepStrictEqual(linuxFacts(50, stat, "ns"), {
      pid: 50,
      parent: 20,
      session: "20",
      tty: "123",
      start: "456",
      namespace: "ns",
    })
    assert.isUndefined(linuxFacts(50, stat.replace(") S", ") Z"), "ns"))
    assert.isUndefined(linuxFacts(51, stat, "ns"))
  })
})

it.effect("daemon detection filters values, distinguishes unavailable from outside and revalidates roots", () =>
  Effect.gen(function* () {
    const fake = (yield* FakeRuntime).runtime
    const seen: Array<Readonly<Record<string, string>>> = []
    let live = true
    let change = false
    const runtime = {
      ...fake,
      kind: "third",
      caller: {
        env: ["THIRD_TERMINAL"],
        detect: (env: Readonly<Record<string, string>>) =>
          Effect.sync(() => {
            seen.push(env)
            if (!env.THIRD_TERMINAL) return undefined
            const result = candidate("third", 20, live)
            if (change) live = false
            return result
          }),
      },
    }
    const facts = [processAt(50, 20, "tty", "20"), processAt(20, 1, "tty", "20")]
    const processes = {
      ...(yield* Processes),
      inspect: (pid: number) => Effect.succeed(facts.find((p) => p.pid === pid)),
    }
    const resolve = (env: Readonly<Record<string, string>>, keys = callerKeys([runtime])) =>
      detectCaller([runtime], { env, keys, pid: 50 }).pipe(Effect.provideService(Processes, processes))
    assert.deepStrictEqual(yield* resolve({}), { status: "outside" })
    assert.deepStrictEqual(yield* resolve({ THIRD_TERMINAL: "test" }), matched("third"))
    assert.deepStrictEqual(seen.at(-1), { THIRD_TERMINAL: "test" })
    assert.strictEqual((yield* resolve({ SECRET: "must-not-reach-plugin" })).status, "unresolved")
    assert.strictEqual(
      seen.some((env) => "SECRET" in env),
      false,
    )
    assert.strictEqual((yield* resolve({}, ["OLD_PLUGIN_KEY"])).status, "unresolved")
    change = true
    assert.strictEqual((yield* resolve({ THIRD_TERMINAL: "test" })).status, "unresolved")
    const broken = {
      ...runtime,
      caller: {
        env: runtime.caller.env,
        detect: () => Effect.fail(new RuntimeError({ code: "unreachable", message: "secret socket path" })),
      },
    }
    const unavailable = yield* detectCaller([broken], {
      pid: 50,
      keys: callerKeys([broken]),
      env: { THIRD_TERMINAL: "test" },
    }).pipe(Effect.provideService(Processes, processes))
    assert.strictEqual(unavailable.status, "unresolved")
    assert.notInclude(JSON.stringify(unavailable), "secret socket path")
    let reads = 0
    live = true
    change = false
    const recycled = yield* detectCaller([runtime], {
      pid: 50,
      keys: callerKeys([runtime]),
      env: { THIRD_TERMINAL: "test" },
    }).pipe(
      Effect.provideService(Processes, {
        ...processes,
        inspect: (pid) =>
          Effect.sync(() => {
            const p = facts.find((f) => f.pid === pid)
            return p && { ...p, start: ++reads > 2 ? "reused-pid" : p.start }
          }),
      }),
    )
    assert.strictEqual(recycled.status, "unresolved")
  }).pipe(Effect.provide(testLayer())),
)
