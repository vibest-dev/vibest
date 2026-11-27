import { assert, describe, it } from "@effect/vitest"
import { type HcClient, HcCoreTooOld, HcError, HcTransportError, type api } from "@vibest/herdr-core-sdk"
import { Effect, Ref, Stream } from "effect"
import { TestClock } from "effect/testing"

import { FOLLOW_ATTEMPTS, failure, hcTerminal, make } from "../src/terminal-runtime.ts"

const HOME = "/run/home.sock"

const hello: api.HelloResult = {
  core: { id: "core-1", name: "home" },
  features: [],
  framed: false,
  generation: 1,
  methods: [],
  version: "0.1.22",
}

const down = (method: string) => new HcTransportError({ method, message: "no answer" })

const fakeClient = (
  socketPath: string,
  greeting: HcClient["hello"],
  subscriptions: Ref.Ref<Record<string, number>>,
): HcClient => ({
  socketPath,
  call: (method) => Effect.fail(down(method)),
  hello: Ref.update(subscriptions, (all) => ({ ...all, hello: (all["hello"] ?? 0) + 1 })).pipe(
    Effect.andThen(greeting),
  ),
  subscribe: () =>
    Stream.unwrap(
      Ref.update(subscriptions, (all) => ({ ...all, [socketPath]: (all[socketPath] ?? 0) + 1 })).pipe(
        Effect.as(Stream.fail(down("events.subscribe"))),
      ),
    ),
})

const runtimeWith = (greeting: HcClient["hello"]) =>
  Effect.gen(function* () {
    const counts = yield* Ref.make<Record<string, number>>({})

    const runtime = yield* make({
      connect: (socket) => Effect.succeed(fakeClient(socket, greeting, counts)),
      socket: HOME,
      scope: yield* Effect.scope,
    })

    return { runtime, counts }
  })

describe("runtime-herdr-core errors, reconnects and doctor", () => {
  it("a send the core holds back is busy, a machine it cannot reach is unreachable", () => {
    const of = (kind: string) => failure(new HcError({ method: "terminal.send", kind, message: kind })).code

    assert.strictEqual(of("cancelled"), "busy")
    assert.strictEqual(of("blocked"), "busy")
    assert.strictEqual(of("unavailable"), "unreachable")
    assert.strictEqual(of("finished"), "not_found")
    assert.strictEqual(of("invalid_params"), "failed")
  })

  it.effect("vibestd's own core is followed past FOLLOW_ATTEMPTS failures; another core stops at FOLLOW_ATTEMPTS", () =>
    Effect.gen(function* () {
      const { runtime, counts } = yield* runtimeWith(Effect.succeed(hello))
      yield* runtime.process({ address: "t1", socket: HOME }).pipe(Effect.ignore)
      yield* runtime.process({ address: "t1", socket: "/run/other.sock" }).pipe(Effect.ignore)

      for (let i = 0; i < 3 * FOLLOW_ATTEMPTS; i++) yield* TestClock.adjust("30 seconds")

      const seen = yield* Ref.get(counts)
      assert.isAbove(seen[HOME] ?? 0, FOLLOW_ATTEMPTS)
      assert.strictEqual(seen["/run/other.sock"], FOLLOW_ATTEMPTS)
    }).pipe(Effect.scoped),
  )

  it.effect("doctor names the core's version, and asks it once whether it answers or not", () =>
    Effect.gen(function* () {
      const online = yield* runtimeWith(Effect.succeed({ ...hello, version: "hc 0.1.22" }))
      assert.deepStrictEqual(yield* online.runtime.doctor!([]), { name: "herdr-core 0.1.22", checks: [] })

      const offline = yield* runtimeWith(Effect.fail(down("hello")))
      assert.deepStrictEqual(yield* offline.runtime.doctor!([]), {
        name: "herdr-core",
        checks: [{ ok: false, text: "herdr-core is not running", fix: "hc server start" }],
      })
      assert.strictEqual((yield* Ref.get(offline.counts))["hello"], 1)

      const old = new HcCoreTooOld({ socketPath: HOME, version: "0.1.9", minimum: "0.1.13", message: "update hc" })
      const blocked = yield* runtimeWith(Effect.fail(old))
      assert.deepStrictEqual(yield* blocked.runtime.doctor!([]), { name: "herdr-core", checks: [] })
      assert.strictEqual((yield* Ref.get(blocked.counts))["hello"], 1)
    }).pipe(Effect.scoped),
  )

  it.effect("open falls back to the home core with no_parent when near points to an unreachable socket", () =>
    Effect.gen(function* () {
      const seen: Array<{ readonly socket: string; readonly params: { readonly no_parent?: boolean } }> = []

      const clientFor = (socketPath: string): HcClient => ({
        socketPath,
        hello: Effect.succeed(hello),
        subscribe: () => Stream.fail(down("events.subscribe")),
        call: ((method: string, params: { readonly no_parent?: boolean }) => {
          seen.push({ socket: socketPath, params })

          if (socketPath !== HOME) return Effect.fail(down(method))

          return Effect.succeed({ address: "t2" })
        }) as HcClient["call"],
      })

      const runtime = yield* make({
        connect: (socket) => Effect.succeed(clientFor(socket)),
        socket: HOME,
        scope: yield* Effect.scope,
      })

      const opened = yield* runtime.open({
        project: "/work/demo",
        cwd: "/work/demo",
        launch: { argv: [], env: {} },
        label: "main",
        near: { address: "t1", socket: "/run/dead.sock" },
      })

      assert.deepStrictEqual(opened, { address: "t2" })
      assert.strictEqual(seen.length, 2)
      assert.strictEqual(seen[0]?.socket, "/run/dead.sock")
      assert.strictEqual(seen[1]?.socket, HOME)
      assert.strictEqual(seen[1]?.params.no_parent, true)
    }).pipe(Effect.scoped),
  )

  it.effect("attach names the terminal's address and pins the core it is on with HC_SOCKET", () =>
    Effect.gen(function* () {
      const { runtime } = yield* runtimeWith(Effect.succeed(hello))
      assert.deepStrictEqual(runtime.attach?.(undefined, { address: "t3", socket: HOME }), [
        "env",
        `HC_SOCKET=${HOME}`,
        "hc",
        "attach",
        "t3",
      ])
      assert.deepStrictEqual(runtime.attach?.(undefined, { address: "t3", socket: "/other.sock" }), [
        "env",
        "HC_SOCKET=/other.sock",
        "hc",
        "attach",
        "t3",
      ])
      assert.deepStrictEqual(runtime.attach?.(undefined), [])
    }).pipe(Effect.scoped),
  )

  it.effect(
    "open sends no_parent when only near is passed, and parent + outlive_parent only when parent is passed",
    () =>
      Effect.gen(function* () {
        const seen: Array<{
          readonly socket: string
          readonly params: { readonly parent?: string; readonly outlive_parent?: boolean; readonly no_parent?: boolean }
        }> = []

        const clientFor = (socketPath: string): HcClient => ({
          socketPath,
          hello: Effect.succeed(hello),
          subscribe: () => Stream.fail(down("events.subscribe")),
          call: ((
            method: string,
            params: { readonly parent?: string; readonly outlive_parent?: boolean; readonly no_parent?: boolean },
          ) => {
            seen.push({ socket: socketPath, params })

            if (params.parent === "gone")
              return Effect.fail(new HcError({ method, kind: "not_found", message: "gone" }))

            return Effect.succeed({ address: `t${seen.length}` })
          }) as HcClient["call"],
        })

        const runtime = yield* make({
          connect: (socket) => Effect.succeed(clientFor(socket)),
          socket: HOME,
          scope: yield* Effect.scope,
        })

        yield* runtime.open({
          project: "/work/demo",
          cwd: "/work/demo",
          launch: { argv: [], env: {} },
          label: "entry",
          near: { address: "t9", socket: HOME },
        })

        assert.strictEqual(seen[0]?.socket, HOME)
        assert.strictEqual(seen[0]?.params.no_parent, true)
        assert.isUndefined(seen[0]?.params.parent)

        yield* runtime.open({
          project: "/work/demo",
          cwd: "/work/demo",
          launch: { argv: [], env: {} },
          label: "subagent",
          parent: { address: "t1", socket: HOME },
          near: { address: "t9", socket: HOME },
        })

        assert.strictEqual(seen[1]?.socket, HOME)
        assert.strictEqual(seen[1]?.params.parent, "t1")
        assert.strictEqual(seen[1]?.params.outlive_parent, true)
        assert.isUndefined(seen[1]?.params.no_parent)

        yield* runtime.open({
          project: "/work/demo",
          cwd: "/work/demo",
          launch: { argv: [], env: {} },
          label: "orphan",
          parent: { address: "gone", socket: HOME },
        })

        assert.strictEqual(seen[2]?.params.parent, "gone")
        assert.strictEqual(seen[3]?.params.no_parent, true)
        assert.isUndefined(seen[3]?.params.parent)
      }).pipe(Effect.scoped),
  )

  it("hcTerminal omits the default socket and keeps secondary sockets", () => {
    assert.deepStrictEqual(hcTerminal(HOME, "t1pk", HOME), { address: "t1pk" })
    assert.deepStrictEqual(hcTerminal(HOME, "mac-mini/t1pk", HOME), { address: "mac-mini/t1pk" })
    assert.deepStrictEqual(hcTerminal("/other.sock", "t2", HOME), { address: "t2", socket: "/other.sock" })
    assert.deepStrictEqual(hcTerminal(HOME, "t1pk"), { address: "t1pk", socket: HOME })
  })
})
