import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { callerTarget, entryPlace, specHits, type CallerHit } from "@vibest/core/caller"
import { Layout, VibestCommand } from "@vibest/core/paths"
import { Builtins, builtinsNode } from "@vibest/core/plugin"
import type { Caller, RuntimeDefinition } from "@vibest/core/plugin/host"
import { HostEnv, make as makeRuntimes, type RuntimeEvent } from "@vibest/core/runtimes"
import { Plugin } from "@vibest/plugin/effect"
import { run as runDaemon } from "@vibest/server/daemon"
import { ConfigProvider, Effect, FileSystem, Layer, Path, PubSub, Queue, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import { hostReplacements } from "./fakes.ts"
import { PATH_WITHOUT_HARNESS_CLIS } from "./fakes.ts"
import { memoryBus } from "./unit-helpers.ts"

const runtime = (id: string, env: ReadonlyArray<string>): Caller => ({
  id,
  env,
  terminal: (values) => Effect.succeed(env.map((key) => values[key]).join("/")),
})

const plugins = [
  runtime("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"]),
  runtime("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"]),
  runtime("rex", ["REX_PANE"]),
]

describe("where the entry session runs", () => {
  const hc = { id: "hc", terminal: "t4@/run/hc/default.sock" } satisfies CallerHit
  const herdr = { id: "herdr", terminal: "vibest/p1" } satisfies CallerHit
  it("no detected runtime is refused, and --runtime launches one", () => {
    const refused = entryPlace({ runtime: undefined, hits: [] })
    assert.strictEqual(refused.in, "refused")
    assert.match(refused.in === "refused" ? refused.message : "", /pass --runtime/)
    assert.deepStrictEqual(entryPlace({ runtime: "herdr", hits: [] }), {
      in: "launch",
      runtime: "herdr",
    })
  })
  it("one detected runtime starts the entry session in that terminal", () => {
    assert.deepStrictEqual(entryPlace({ runtime: undefined, hits: [hc] }), {
      in: "terminal",
      runtime: "hc",
      terminal: hc.terminal,
    })
    assert.deepStrictEqual(entryPlace({ runtime: undefined, hits: [herdr] }), {
      in: "terminal",
      runtime: "herdr",
      terminal: herdr.terminal,
    })
    assert.strictEqual(entryPlace({ runtime: undefined, hits: [{ ...herdr, terminal: undefined }] }).in, "refused")
  })
  it("two detected runtimes follow load order, and --runtime overrides", () => {
    assert.deepStrictEqual(entryPlace({ runtime: undefined, hits: [hc, herdr] }), {
      in: "terminal",
      runtime: "hc",
      terminal: hc.terminal,
    })
    assert.deepStrictEqual(entryPlace({ runtime: undefined, hits: [herdr, hc] }), {
      in: "terminal",
      runtime: "herdr",
      terminal: herdr.terminal,
    })
    assert.deepStrictEqual(entryPlace({ runtime: "herdr", hits: [herdr, hc] }), {
      in: "terminal",
      runtime: "herdr",
      terminal: herdr.terminal,
    })
    assert.deepStrictEqual(entryPlace({ runtime: "hc", hits: [herdr] }), {
      in: "launch",
      runtime: "hc",
    })
  })
})

describe("the runtime registry", () => {
  const definition = (id: string, env: ReadonlyArray<string>, events: Stream.Stream<RuntimeEvent> = Stream.never) =>
    ({
      id,
      caller: {
        env,
        terminal: (values: Readonly<Record<string, string | undefined>>) => Effect.succeed(values[env[0]!]),
      },
      events,
    }) as unknown as RuntimeDefinition

  it.effect(
    "the first registered definition wins detection, its caller variables leave vibestd's environment, and a removed definition's events stop",
    () =>
      Effect.gen(function* () {
        const dropped: Array<string> = []
        const bus = yield* Bus
        const seen = yield* bus.subscribe()
        const runtimes = yield* makeRuntimes.pipe(
          Effect.provideService(HostEnv, { drop: (names) => void dropped.push(...names) }),
        )
        const queue = yield* Queue.unbounded<RuntimeEvent>()
        yield* runtimes.transform((editor) => editor.add(definition("hc", ["HC_ID"])))
        const herdr = yield* runtimes.transform((editor) =>
          editor.add(definition("herdr", ["HERDR_ID"], Stream.fromQueue(queue))),
        )
        const env = { HC_ID: "t1", HERDR_ID: "p1" }
        assert.deepStrictEqual(
          entryPlace({ runtime: undefined, hits: yield* specHits(yield* runtimes.callers, env) }),
          {
            in: "terminal",
            runtime: "hc",
            terminal: "t1",
          },
        )
        assert.includeMembers(dropped, ["HC_ID", "HERDR_ID"])
        const exited = (id: string): RuntimeEvent => ({ type: "exited", terminal: { id } })
        const until = (type: "terminal.exited" | "drain.released") =>
          Effect.gen(function* () {
            const passed: Array<string> = []
            for (;;) {
              const event = yield* PubSub.take(seen)
              if (event.type === "terminal.exited") passed.push(event.terminal.id)
              if (event.type === type) return passed
            }
          })
        yield* Queue.offer(queue, exited("first"))
        assert.deepStrictEqual(yield* until("terminal.exited"), ["first"])
        yield* herdr.dispose
        yield* Queue.offer(queue, exited("after"))
        for (let i = 0; i < 20; i++) yield* Effect.yieldNow
        yield* bus.observe({ type: "drain.released" })
        assert.deepStrictEqual(yield* until("drain.released"), [])
        assert.deepStrictEqual(
          (yield* runtimes.all).map((runtime) => runtime.id),
          ["hc"],
        )
      }).pipe(Effect.scoped, Effect.provide(memoryBus)),
  )
})

describe("caller runtimes", () => {
  it.effect("without an earlier runtime's environment the next one in load order wins", () =>
    Effect.gen(function* () {
      const hits = yield* specHits(plugins, {
        REX_PANE: "rex-9",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      })
      assert.deepStrictEqual(entryPlace({ runtime: undefined, hits }), {
        in: "terminal",
        runtime: "herdr",
        terminal: "p1//herdr.sock",
      })
    }),
  )

  it.effect("terminal() runs only for the first detected runtime, or the runtime --runtime names", () =>
    Effect.gen(function* () {
      const calls: Array<string> = []
      const watch = (id: string, env: ReadonlyArray<string>, terminal: string, fail = false): Caller => ({
        id,
        env,
        terminal: () => {
          calls.push(id)
          return fail ? Effect.fail(`${id} down`) : Effect.succeed(terminal)
        },
      })
      const env = {
        HC_TERMINAL_ID: "t1",
        HC_TERMINAL_SOCKET: "/hc.sock",
        HERDR_PANE_ID: "p1",
        HERDR_SOCKET_PATH: "/herdr.sock",
      }
      const hits = yield* specHits(
        [
          watch("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term"),
          watch("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term", true),
        ],
        env,
      )
      assert.deepStrictEqual(calls, ["hc"])
      assert.deepStrictEqual(entryPlace({ runtime: undefined, hits }), {
        in: "terminal",
        runtime: "hc",
        terminal: "hc-term",
      })
      calls.length = 0
      const named = yield* specHits(
        [
          watch("hc", ["HC_TERMINAL_ID", "HC_TERMINAL_SOCKET"], "hc-term", true),
          watch("herdr", ["HERDR_PANE_ID", "HERDR_SOCKET_PATH"], "herdr-term"),
        ],
        env,
        "herdr",
      )
      assert.deepStrictEqual(calls, ["herdr"])
      assert.deepStrictEqual(entryPlace({ runtime: "herdr", hits: named }), {
        in: "terminal",
        runtime: "herdr",
        terminal: "herdr-term",
      })
    }),
  )

  it("callerTarget uses the socket path, a named session, or no target, and a plugin never sees keys it did not declare", () => {
    const seen: Array<Record<string, string | undefined>> = []
    const herdr = {
      env: ["HERDR_SOCKET_PATH"],
      target: (env: Readonly<Record<string, string | undefined>>, named?: string) => {
        seen.push({ ...env })
        if (named !== undefined) return `session:${named}`
        return env.HERDR_SOCKET_PATH === undefined ? undefined : `socket:${env.HERDR_SOCKET_PATH}`
      },
    }
    const env = { HERDR_SOCKET_PATH: "/h.sock", HERDR_PANE_ID: "p1", OTHER: "x" }
    assert.strictEqual(callerTarget([herdr], env), "socket:/h.sock")
    assert.deepStrictEqual(seen, [{ HERDR_SOCKET_PATH: "/h.sock" }])
    assert.strictEqual(callerTarget([herdr], env, "other"), "session:other")
    assert.strictEqual(callerTarget([herdr], {}), undefined)
    assert.strictEqual(callerTarget([{ env: ["REX_PANE"] }], env), undefined)
  })

  it.live("a user runtime env key does not reach a process vibestd starts", () =>
    Effect.gen(function* () {
      const key = "VIBEST_USER_RUNTIME_ID"
      const previous = process.env[key]
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env[key]
          else process.env[key] = previous
        }),
      )
      process.env[key] = "leaked"
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const base = path.join(import.meta.dirname, ".tmp")
      yield* fs.makeDirectory(base, { recursive: true })
      const dir = yield* fs.makeTempDirectoryScoped({ directory: base })
      yield* fs.makeDirectory(path.join(dir, "plugins"))
      const user = Plugin.define({
        id: "runtime-user",
        effect: (context) =>
          context.runtime
            .transform((editor) =>
              editor.add({
                id: "user",
                caller: { env: [key], terminal: () => Effect.succeed(undefined) },
                status: () => Effect.succeed({ status: "offline", reason: "test" }),
                events: Stream.never,
              } as unknown as RuntimeDefinition),
            )
            .pipe(Effect.asVoid),
      })
      const replacements = [
        ...Platform.replacements,
        ...hostReplacements,
        builtinsNode.replace(
          Layer.succeed(Builtins, [{ source: "builtin:runtime-user", revision: "-", options: {}, plugin: user }]),
        ),
      ]
      const layout = yield* Layout.make(dir)
      yield* runDaemon(Platform.daemon, replacements).pipe(
        Effect.provideService(Layout, layout),
        Effect.provideService(VibestCommand, ["/bin/vibest"]),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: dir, PATH: PATH_WITHOUT_HARNESS_CLIS })),
        ),
        Effect.forkScoped,
      )
      yield* Effect.gen(function* () {
        while (process.env[key] !== undefined) yield* Effect.sleep("20 millis")
      }).pipe(Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("caller env was not dropped") }))
      const out = yield* (yield* ChildProcessSpawner.ChildProcessSpawner).string(
        ChildProcess.make("sh", ["-c", `printf %s "\${${key}-}"`]),
      )
      assert.strictEqual(out, "")
    }).pipe(Effect.provide(Platform.services)),
  )
})
