import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Builtins, PluginLoader, Plugins } from "@vibest/core/plugins"
import { Runtimes } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { mainCheckout } from "@vibest/core/worktree"
import { AgentRefused as PluginRefused, Plugin, type AgentStartBefore, type Registration } from "@vibest/plugin"
import { Context, Effect, Fiber, FileSystem, Layer, Path, type Scope } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import {
  FakeRuntime,
  makeRepository,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  harnessesLayer,
  projectOf,
} from "./fakes.ts"

const spawnInput = (repo: string, extra: { harness?: "pi" | "claude"; model?: string; prompt?: string } = {}) =>
  Effect.map(projectOf(repo), (projectId) => ({
    machine: { id: "local" },
    root: repo,
    projectId,
    name: "task",
    prompt: extra.prompt ?? "do it",
    runtime: "herdr",
    ...extra,
  }))

const hook = (id: string, callback: (e: AgentStartBefore) => Effect.Effect<void, PluginRefused>) =>
  Plugin.define({ id, effect: (ctx) => ctx.agent.hook("start.before", callback) })
const write = (id: string, f: (e: AgentStartBefore) => void) => hook(id, (e) => Effect.sync(() => f(e)))

const HARNESS_MODELS = ["claude-haiku-5-5", "a", "b", "two", "after", "m"]

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>, options?: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer({ models: HARNESS_MODELS, ...options }))))

const sessionRowsAndRuntimeOpens = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  return { rows: (yield* db.listSessions()).length, starts: (yield* herdr.callsTo("open")).length }
})

describe("plugins: spawn hook", () => {
  test(
    "P5/P8: the event has the resolved root; writes reach the row and the launch args",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const nested = `${repo}/sub`
      yield* (yield* FileSystem.FileSystem).makeDirectory(nested)
      const s = yield* (yield* Sessions).spawn(
        yield* spawnInput(yield* mainCheckout(nested), { prompt: "research: how does the cache work?" }),
      )
      assert.strictEqual(s.harness, "claude")
      assert.strictEqual(s.model, "claude-haiku-5-5")
      assert.deepStrictEqual(s.decidedBy, { harness: "route", model: "route" })
      const row = (yield* db.getSession(s.id))!
      assert.strictEqual(row.harnessId, "claude")
      assert.strictEqual(row.model, "claude-haiku-5-5")
      assert.deepStrictEqual(row.metadata.routing?.decidedBy, {
        harness: "route",
        model: "route",
      })
      yield* until(herdr.callsTo("open"), (c) => c.length > 0)
      const args = (yield* herdr.callsTo("open"))[0]!.argv
      assert.include(args.join(" "), "--model claude-haiku-5-5")
    }),
    {
      plugins: [
        hook("route", (e) =>
          Effect.sync(() => {
            assert.strictEqual(e.project.endsWith("/sub"), false)
            if (e.prompt.startsWith("research:")) {
              e.harness = "claude"
              e.model = "claude-haiku-5-5"
            }
          }),
        ),
      ],
    },
  )

  const stuckHookEntered = { value: false }
  const pastUninterruptibleSleep = "1 minute"
  test(
    "P3: a hook stuck in an uninterruptible sleep times out and refuses the start",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const spawning = yield* Effect.forkChild((yield* Sessions).spawn(yield* spawnInput(repo, { harness: "pi" })))
      yield* until(
        Effect.sync(() => stuckHookEntered.value),
        (x) => x,
      )
      yield* TestClock.adjust("5 seconds")
      const error = yield* Effect.flip(Fiber.join(spawning))
      assert.strictEqual(error._tag, "AgentRefused")
      assert.deepInclude(error, { plugin: "stuck", reason: "plugin stuck timed out after 5s" })
      assert.deepStrictEqual(yield* sessionRowsAndRuntimeOpens, { rows: 0, starts: 0 })
      yield* TestClock.adjust(pastUninterruptibleSleep)
    }),
    {
      plugins: [
        hook("stuck", () =>
          Effect.sync(() => (stuckHookEntered.value = true)).pipe(
            Effect.andThen(Effect.uninterruptible(Effect.sleep(pastUninterruptibleSleep))),
          ),
        ),
        write("after", () => assert.fail("must not run after a timeout")),
      ],
    },
  )

  test(
    "a plugin can rewrite the prompt the session receives",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const s = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" }))
      assert.deepStrictEqual(s.trace.at(-1)!.changes, [
        { field: "prompt", from: "do it", to: "do it\n\nRun the tests first." },
      ])
      yield* until(herdr.callsTo("send"), (c) => c.length > 0)
      assert.include((yield* herdr.callsTo("send"))[0]!.text, "Run the tests first.")
    }),
    { plugins: [write("rules", (e) => (e.prompt += "\n\nRun the tests first."))] },
  )

  test(
    "P8/P14: an unknown harness written by a plugin is refused, naming it; one that unsets the harness leaves NoHarnessChosen",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const error = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(repo)))
      assert.strictEqual(error._tag, "HarnessUnavailable")
      assert.include(error.message, "vim")
      assert.include(error.message, "editor")
      assert.deepStrictEqual(yield* sessionRowsAndRuntimeOpens, { rows: 0, starts: 0 })
      const unset = yield* Effect.flip((yield* Sessions).spawn(yield* spawnInput(repo, { prompt: "unset" })))
      assert.strictEqual(unset._tag, "NoHarnessChosen")
      assert.include(unset.message, "no harness to inherit")
    }),
    { plugins: [write("editor", (e) => (e.harness = e.prompt === "unset" ? undefined : "vim"))] },
  )

  test(
    "P10/P12: setup failures are isolated; counters follow the runs",
    Effect.gen(function* () {
      const plugins = yield* Plugins
      const listed = yield* plugins.list
      const byId = (id: string) => listed.filter((q) => q.id === id)
      assert.deepInclude(byId("runtime-choice")[0], { status: "active" })
      assert.deepInclude(byId("broken")[0], { id: "broken", status: "failed" })
      assert.include(byId("broken")[0]!.error, "setup boom")
      assert.deepInclude(byId("ok")[0], { id: "ok", status: "active", calls: 0 })
      assert.deepInclude(byId("ok")[1], { id: "ok", status: "failed", error: "Duplicate plugin ID: ok" })
      yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" }))
      assert.deepInclude(
        (yield* plugins.list).find((q) => q.id === "ok")!,
        { calls: 1, changed: 1, crashed: 0 },
      )
    }),
    {
      plugins: [
        Plugin.define({
          id: "broken",
          effect: (ctx) =>
            ctx.agent
              .hook("start.before", () => Effect.sync(() => assert.fail("hook of a failed setup ran")))
              .pipe(Effect.andThen(Effect.die("setup boom"))),
        }),
        write("ok", (e) => (e.model = "m")),
        write("ok", () => {}),
      ],
    },
  )

  const stale = (id: string, name: string) =>
    Plugin.define({
      id,
      effect: (ctx) =>
        ctx.agent.hook(name as never, () => Effect.sync(() => assert.fail(`${name} ran as a startup hook`))),
    })

  test(
    "old and unknown hook names fail the plugin's setup instead of running at startup",
    Effect.gen(function* () {
      const s = yield* (yield* Sessions).spawn(yield* spawnInput(yield* makeRepository, { harness: "pi" }))
      assert.deepStrictEqual(
        s.trace.map((t) => [t.plugin, t.outcome]),
        [
          ["runtime-choice", "ok"],
          ["current", "ok"],
        ],
      )
      assert.strictEqual(s.model, "m")
      const listed = yield* (yield* Plugins).list
      assert.deepStrictEqual(
        listed.map((p) => [p.id, p.status]),
        [
          ["runtime-choice", "active"],
          ["session", "failed"],
          ["worker", "failed"],
          ["typo", "failed"],
          ["proto", "failed"],
          ["current", "active"],
        ],
      )
      const supported = "agent.start.before, agent.fail"
      assert.include(listed[1]!.error, `unsupported hook "agent.session.spawn"; supported: ${supported}`)
      assert.include(listed[2]!.error, `unsupported hook "agent.worker.spawn"`)
      assert.include(listed[3]!.error, `unsupported hook "agent.session.start"`)
      assert.include(listed[4]!.error, `unsupported hook "agent.toString"`)
    }),
    {
      plugins: [
        stale("session", "session.spawn"),
        stale("worker", "worker.spawn"),
        stale("typo", "session.start"),
        stale("proto", "toString"),
        write("current", (e) => (e.model = "m")),
      ],
    },
  )

  it.effect("P10: a setup that never returns times out without blocking the others", () =>
    Effect.gen(function* () {
      const building = yield* Effect.forkChild(
        Plugins.make([
          {
            source: "hang",
            revision: "-",
            options: {},
            plugin: Plugin.define({ id: "hang", effect: () => Effect.never }),
          },
          { source: "ok", revision: "-", options: {}, plugin: write("ok", () => {}) },
        ]),
      )
      yield* TestClock.adjust("5 seconds")
      const plugins = yield* Fiber.join(building)
      assert.deepStrictEqual(
        (yield* plugins.list).map((p) => [p.id, p.status, p.error]),
        [
          ["hang", "failed", "setup timed out"],
          ["ok", "active", undefined],
        ],
      )
    }).pipe(
      Effect.scoped,
      Effect.provide(Subscriptions.layer),
      Effect.provide(harnessesLayer()),
      Effect.provide(Runtimes.layer),
      Effect.provide(Bus.layer),
    ),
  )

  it.effect(
    "an agent hook's dispose stops its callback before the scope closes, a second dispose does nothing, and a running dispatch keeps its snapshot",
    () =>
      Effect.gen(function* () {
        const calls: Array<string> = []
        const registrations: Record<string, Registration> = {}
        const recorder = (id: string, after: () => Effect.Effect<void> = () => Effect.void) =>
          Plugin.define({
            id,
            effect: (ctx) =>
              ctx.agent
                .hook("start.before", () => Effect.sync(() => calls.push(id)).pipe(Effect.andThen(after())))
                .pipe(Effect.map((registration) => void (registrations[id] = registration))),
          })
        const plugins = yield* Plugins.make([
          { source: "a", revision: "-", options: {}, plugin: recorder("a", () => registrations.b!.dispose) },
          { source: "b", revision: "-", options: {}, plugin: recorder("b") },
        ])
        yield* plugins.start(event)
        assert.deepStrictEqual(calls, ["a", "b"])
        yield* plugins.start(event)
        assert.deepStrictEqual(calls, ["a", "b", "a"])
        yield* registrations.a!.dispose
        yield* registrations.a!.dispose
        yield* registrations.b!.dispose
        yield* plugins.start(event)
        assert.deepStrictEqual(calls, ["a", "b", "a"])
        assert.deepStrictEqual(
          (yield* plugins.list).map((p) => [p.id, p.status, p.calls]),
          [
            ["a", "active", 2],
            ["b", "active", 1],
          ],
        )
      }).pipe(
        Effect.scoped,
        Effect.provide(Subscriptions.layer),
        Effect.provide(harnessesLayer()),
        Effect.provide(Runtimes.layer),
        Effect.provide(Bus.layer),
      ),
  )
})

const packageHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const base = path.join(import.meta.dirname, ".tmp")
  yield* fs.makeDirectory(base, { recursive: true })
  const dir = yield* fs.makeTempDirectoryScoped({ directory: base })
  yield* fs.makeDirectory(path.join(dir, "plugins"))
  return dir
})

const source = (id: string, model: string) => `import { Plugin } from "@vibest/plugin"
import { Effect } from "effect"
export default Plugin.define({ id: ${JSON.stringify(id)}, effect: (ctx) => ctx.agent.hook("start.before", (e) => Effect.sync(() => { e.model = ${JSON.stringify(model)} })) })
`

const loaded = (dir: string) =>
  Plugins.layer.pipe(
    Layer.provide(Layer.succeed(PluginLoader, { ...Platform.plugins, prepare: Effect.void })),
    Layer.provide(Layer.succeed(Builtins, [])),
    Layer.provide(Subscriptions.layer),
    Layer.provide(harnessesLayer()),
    Layer.provide(Layer.effect(Layout, Layout.make(dir))),
    Layer.provide(Runtimes.layer),
    Layer.provide(Bus.layer),
    Layer.build,
    Effect.map(Context.get(Plugins)),
  )

const event = {
  project: "/r",
  agentType: "general",
  parentSessionId: undefined,
  prompt: "p",
  harness: undefined,
  provider: undefined,
  model: undefined,
  machine: { id: "local" },
  runtime: undefined,
  parentRuntime: undefined,
  machines: [],
  attempts: [],
  harnesses: [
    { harness: "pi", available: true },
    { harness: "claude", available: true },
    { harness: "cursor", available: true },
  ],
}

describe("plugins: loading", () => {
  it.live(
    "P1: plugins/ first in path order, then vibest.json in its order (a local entry may be one source file); -x removes; bad entries fail visibly",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const dir = yield* packageHome
        const plugins = path.join(dir, "plugins")
        yield* fs.writeFileString(path.join(plugins, "b.ts"), source("b", "from-b"))
        yield* fs.writeFileString(path.join(plugins, "a.ts"), source("a", "from-a"))
        yield* fs.writeFileString(path.join(plugins, "a.d.ts"), "export {}")
        yield* fs.writeFileString(path.join(plugins, ".hidden.ts"), source("hidden", "from-hidden"))
        yield* fs.writeFileString(path.join(plugins, "notes.md"), "not a plugin")
        yield* fs.makeDirectory(path.join(plugins, "empty"))
        yield* fs.makeDirectory(path.join(plugins, "node_modules"))
        yield* fs.writeFileString(path.join(plugins, "broken.ts"), "export default 42\n")
        for (const name of ["x", "y"]) {
          yield* fs.makeDirectory(path.join(dir, name))
          yield* fs.writeFileString(path.join(dir, name, "index.ts"), source(name, `from-${name}`))
        }
        yield* fs.writeFileString(path.join(dir, "a-file.ts"), source("f", "from-f"))
        const config = (entries: ReadonlyArray<unknown>) =>
          fs.writeFileString(
            path.join(dir, "vibest.json"),
            `// comments are fine\n{ "plugins": ${JSON.stringify(entries)}, }\n`,
          )

        yield* config(["./x", "./y", "-b", "vibest-plugin-npm@1.0.0", "./a-file.ts"])
        const first = yield* loaded(dir)
        assert.deepStrictEqual(
          (yield* first.list).map((p) => [p.id, p.status]),
          [
            ["a", "active"],
            [path.join(plugins, "broken.ts"), "failed"],
            ["x", "active"],
            ["y", "active"],
            ["vibest-plugin-npm@1.0.0", "failed"],
            ["f", "active"],
          ],
        )
        const listed = yield* first.list
        assert.include(listed.find((p) => p.id.endsWith("broken.ts"))!.error, "Plugin.define")
        assert.include(listed.find((p) => p.id.startsWith("vibest-plugin-npm"))!.error, "not supported yet")
        assert.match(listed.find((p) => p.id === "a")!.revision, /^[0-9a-f]{12}$/)
        assert.strictEqual((yield* first.start(event)).model, "from-f")

        yield* config(["-*", "./y", "./x"])
        const second = yield* loaded(dir)
        assert.deepStrictEqual(
          (yield* second.list).map((p) => p.id),
          ["y", "x"],
        )
        assert.strictEqual((yield* second.start(event)).model, "from-x")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
