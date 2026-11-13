import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Harness, HarnessUnavailable } from "@vibest/core/harness"
import { Layout } from "@vibest/core/paths"
import { Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { claude, claudePlugin, cursor, pi, piPlugin } from "@vibest/plugin-harnesses"
import { keychainProblem } from "@vibest/plugin-harnesses/cursor"
import { cursorSubscription } from "@vibest/plugin-harnesses/subscriptions/cursor"
import { type Harness as HarnessTypes, Plugin } from "@vibest/plugin/effect"
import * as Server from "@vibest/server/server"
import { ConfigProvider, Context, Effect, Fiber, FileSystem, Layer, Logger, Option, Path, Stream } from "effect"
import { Sink } from "effect"
import { Headers, HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import {
  agentsLayer,
  runtimesLayer,
  subscriptionsLayer,
  harnessesLayer,
  makeRepository,
  runVibest,
  testLayer,
} from "./fakes.ts"

const CLAUDE_SECRET = "claude-token-do-not-log"
const PI_SECRET = "pi-key-do-not-log"

const claudeStatus = JSON.stringify({
  loggedIn: true,
  authMethod: "claude.ai",
  subscriptionType: "max",
  email: "a@b.c",
})
const claudeBody = {
  five_hour: { utilization: 4, resets_at: "2026-10-31T17:20:00.296129+00:00" },
  seven_day: { utilization: 100, resets_at: "2026-11-01T21:00:00.296147+00:00" },
  seven_day_opus: null,
}
const cursorBody = {
  billingCycleEnd: "1794886804000",
  planUsage: { totalPercentUsed: 35.891, autoPercentUsed: 36.289, apiPercentUsed: 23.94, limit: 40000 },
}

interface Spawned {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly stdin: unknown
}

const output = (stdout: string, exitCode: Effect.Effect<number> = Effect.succeed(0)) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.map(exitCode, (code) => ChildProcessSpawner.ExitCode(code)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(new TextEncoder().encode(stdout)),
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  })

const harnessLayer = (installed: ReadonlyArray<string>) =>
  Layer.succeed(Harness, {
    available: (id) => Effect.succeed(installed.includes(id)),
    plugin: (id) => Effect.fail(new HarnessUnavailable({ harness: id, message: "unused" })),
    models: () => Effect.die("unused"),
  })

const fakeMachine = (options: {
  readonly installed: ReadonlyArray<string>
  readonly commands: Readonly<Record<string, string>>
  readonly commandsThatNeverExit?: ReadonlyArray<string>
  readonly http?: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>
  readonly httpHang?: ReadonlyArray<string>
  readonly home: string
  readonly fileSystem?: FileSystem.FileSystem
}) => {
  const spawned: Array<Spawned> = []
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
  const logs: Array<unknown> = []
  const hanging = new Set(options.commandsThatNeverExit ?? [])
  const spawner = ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return Effect.die("piped")
    const id = [command.command, ...command.args].join(" ")
    spawned.push({ command: command.command, args: command.args, stdin: command.options.stdin })
    return Effect.succeed(
      output(hanging.has(id) ? "" : (options.commands[id] ?? ""), hanging.has(id) ? Effect.never : Effect.succeed(0)),
    )
  })
  const http = HttpClient.make((request) => {
    requests.push({
      url: request.url,
      authorization: Option.getOrUndefined(Headers.get(request.headers, "authorization")),
    })
    if ((options.httpHang ?? []).includes(request.url)) return Effect.never
    const hit = options.http?.[request.url] ?? { status: 599, body: {} }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(hit.body), { status: hit.status })),
    )
  })
  const machine = Layer.mergeAll(
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    options.fileSystem === undefined ? Layer.empty : Layer.succeed(FileSystem.FileSystem, options.fileSystem),
  )
  const onMachine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(machine), Effect.provide(Platform.services), Effect.orDie)
  const registered = (assembled: typeof claudePlugin) =>
    Effect.gen(function* () {
      const plugin = yield* assembled
      const added: Array<HarnessTypes.HarnessDefinition> = []
      const editor = { add: (definition: HarnessTypes.HarnessDefinition) => added.push(definition) }
      const registration = { dispose: Effect.void }
      const ctx = {
        harness: {
          transform: (edit: (e: typeof editor) => unknown) => Effect.sync(() => (edit(editor), registration)),
        },
      } as unknown as Parameters<typeof plugin.effect>[0]
      yield* plugin.effect(ctx)
      return added[0]!
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner))
  const cursorDefinition = {
    ...cursor,
    subscription: (dir: string) =>
      onMachine(Effect.flatMap(keychainProblem(dir), (problem) => cursorSubscription(spawner)(dir, problem))),
  }
  const definitions = Effect.all([registered(claudePlugin), registered(piPlugin)]).pipe(
    Effect.map(([claudeDefinition, piDefinition]) => [claudeDefinition, cursorDefinition, piDefinition]),
  )
  const fakes = Subscriptions.testLayer.pipe(
    Layer.provideMerge(Layer.unwrap(Effect.map(definitions, harnessesLayer))),
    Layer.provideMerge(harnessLayer(options.installed)),
  )
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(fakes),
      Effect.provide(Platform.services),
      Effect.provide(Logger.layer([Logger.make((entry) => void logs.push(entry.message))])),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ HOME: options.home, PI_CODING_AGENT_DIR: `${options.home}/.pi/agent` }),
        ),
      ),
    )
  return { spawned, requests, logs, layer: fakes, provide }
}

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "vibest-subs-" })
}).pipe(Effect.provide(Platform.services), Effect.orDie)

describe("subscription polls and vibest subscriptions over fake CLIs, keychain and HTTP: nothing touches the network", () => {
  it.effect("Claude and Cursor report their logins with no usage limits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      yield* fs.makeDirectory(path.join(dir, "Library", "Keychains"), { recursive: true })
      yield* fs.writeFileString(
        path.join(dir, "Library", "Keychains", "login.keychain-db"),
        "fake keychain; no real CLI",
      )
      const commands: Record<string, string> = {
        "claude auth status --json": claudeStatus,
        "cursor-agent status --format json": JSON.stringify({ isAuthenticated: true }),
        "cursor-agent about --format json": JSON.stringify({ subscriptionTier: "Ultra" }),
        "pi --list-models": ["provider model", "example-proxy m", "custom-proxy c", "anthropic a"].join("\n"),
        "pi auth check --provider example-proxy --json --no-refresh": JSON.stringify({
          status: "ready",
          authType: "api_key",
        }),
        "pi auth check --provider custom-proxy --json --no-refresh": JSON.stringify({
          status: "not_ready",
          provider: "custom-proxy",
          reason: "credentials_not_configured",
        }),
        "pi auth check --provider anthropic --json --no-refresh": JSON.stringify({
          status: "not_ready",
          provider: "anthropic",
          reason: "credentials_not_configured",
        }),
      }
      const fake = fakeMachine({
        installed: ["claude", "cursor", "pi"],
        commands,
        home: dir,
        http: { "https://api.anthropic.com/api/oauth/usage": { status: 200, body: claudeBody } },
      })
      const listed = yield* fake.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          yield* subs.report({
            harness: "claude",
            limits: [{ window: "5h", percent: 1, status: "available", resetTime: null }],
          })
          yield* subs.report({
            harness: "cursor",
            limits: [{ window: "monthly", percent: 2, status: "available", resetTime: null }],
          })
          yield* subs.report({
            harness: "pi",
            provider: "example-proxy",
            limits: [{ window: "monthly", percent: 7, status: "available", resetTime: null }],
          })
          yield* subs.report({ harness: "nope", limits: [] })
          yield* subs.poll
          return yield* subs.list
        }),
      )
      assert.deepStrictEqual(
        listed.map((row) => [
          row.harness,
          row.provider,
          row.account.kind,
          row.account.plan,
          row.error,
          row.limits[0]?.percent,
        ]),
        [
          ["claude", "", "subscription", "max", undefined, undefined],
          ["cursor", "", "subscription", "Ultra", undefined, undefined],
          ["pi", "anthropic", "none", undefined, undefined, undefined],
          ["pi", "custom-proxy", "none", undefined, undefined, undefined],
          ["pi", "example-proxy", "api-key", undefined, undefined, 7],
        ],
      )
      assert.deepStrictEqual(fake.requests, [])
      for (const spawn of fake.spawned) assert.strictEqual(spawn.stdin, "ignore", spawn.command)
      assert.deepStrictEqual(
        fake.spawned.map((spawn) => [spawn.command, ...spawn.args].join(" ")).sort(),
        Object.keys(commands).sort(),
      )
      const leaked = JSON.stringify({ listed, logs: fake.logs, spawned: fake.spawned })
      assert.notInclude(leaked, CLAUDE_SECRET)
      assert.notInclude(leaked, PI_SECRET)
      assert.notInclude(leaked, "a@b.c")
    }).pipe(Effect.provide(Platform.services)),
  )

  it.effect("a poll reports no usage limits and replaces a plugin's limits; a hung CLI keeps the last limits", () =>
    Effect.gen(function* () {
      const dir = yield* home
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(`${dir}/Library/Keychains`, { recursive: true })
      yield* fs.writeFileString(`${dir}/Library/Keychains/login.keychain-db`, "fake keychain; no real CLI")
      const fresh = fakeMachine({
        installed: ["claude", "cursor"],
        home: dir,
        commands: {
          "claude auth status --json": claudeStatus,
          "cursor-agent status --format json": JSON.stringify({ isAuthenticated: true }),
          "cursor-agent about --format json": JSON.stringify({ subscriptionTier: "Ultra" }),
        },
        http: {
          "https://api.anthropic.com/api/oauth/usage": { status: 200, body: claudeBody },
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage": {
            status: 200,
            body: cursorBody,
          },
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit": {
            status: 200,
            body: { noUsageBasedAllowed: true },
          },
        },
      })
      const listed = yield* fresh.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          yield* subs.report({
            harness: "claude",
            limits: [{ window: "5h", percent: 1, status: "available", resetTime: 5 }],
          })
          yield* subs.poll
          return yield* subs.list
        }),
      )
      assert.deepStrictEqual(listed.find((row) => row.harness === "claude")?.limits, [])
      assert.strictEqual(listed.find((row) => row.harness === "claude")?.error, undefined)
      const cursorRow = listed.find((row) => row.harness === "cursor")
      assert.deepStrictEqual(cursorRow?.limits, [])
      assert.strictEqual(cursorRow?.error, undefined)
      assert.strictEqual(cursorRow?.account.plan, "Ultra")
      assert.deepStrictEqual(fresh.requests, [])
      assert.notInclude(JSON.stringify({ logs: fresh.logs, listed }), CLAUDE_SECRET)

      const denied = fakeMachine({
        installed: ["claude"],
        home: dir,
        commands: { "claude auth status --json": claudeStatus },
        http: { "https://api.anthropic.com/api/oauth/usage": { status: 401, body: { error: CLAUDE_SECRET } } },
      })
      const kept = yield* denied.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          yield* subs.report({
            harness: "claude",
            limits: [{ window: "5h", percent: 9, status: "available", resetTime: null }],
          })
          yield* subs.poll
          return (yield* subs.list)[0]!
        }),
      )
      assert.strictEqual(kept.error, undefined)
      assert.deepStrictEqual(kept.limits, [])
      assert.strictEqual(kept.account.plan, "max")
      assert.deepStrictEqual(denied.requests, [])
      assert.notInclude(JSON.stringify(kept) + JSON.stringify(denied.logs), CLAUDE_SECRET)

      const hung = fakeMachine({
        installed: ["claude"],
        home: dir,
        commands: {},
        commandsThatNeverExit: ["claude auth status --json"],
      })
      const row = yield* hung.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          yield* subs.report({
            harness: "claude",
            limits: [{ window: "5h", percent: 8, status: "available", resetTime: null }],
          })
          const pending = yield* Effect.forkChild(subs.poll)
          yield* TestClock.adjust("10 seconds")
          yield* Fiber.join(pending)
          return (yield* subs.list)[0]!
        }),
      )
      assert.strictEqual(row.error, "claude auth status failed")
      assert.strictEqual(row.limits[0]?.percent, 8)
      assert.strictEqual(hung.requests.length, 0)
    }).pipe(Effect.provide(Platform.services)),
  )

  const loggedOut = (dir: string) =>
    fakeMachine({
      installed: ["claude"],
      home: dir,
      commands: { "claude auth status --json": JSON.stringify({ loggedIn: false }) },
    })

  it.effect("a harness subscription that never answers is cut off after 30 s and the next harness is still read", () =>
    Effect.gen(function* () {
      const subs = yield* Subscriptions
      const polling = yield* Effect.forkChild(subs.poll)
      yield* TestClock.adjust("30 seconds")
      yield* Fiber.join(polling)
      assert.deepStrictEqual(
        (yield* subs.list).map((row) => [row.harness, row.account.kind]),
        [["pi", "none"]],
      )
    }).pipe(
      Effect.provide(
        Subscriptions.testLayer.pipe(
          Layer.provideMerge(
            harnessesLayer([
              { ...claude, subscription: () => Effect.never },
              { ...pi, subscription: () => Effect.succeed([{ provider: "", account: { kind: "none" } }]) },
            ]),
          ),
          Layer.provideMerge(harnessLayer(["claude", "pi"])),
        ),
      ),
    ),
  )

  it.effect("while vibestd runs: one poll at start, then none over an idle hour", () =>
    Effect.gen(function* () {
      const fake = loggedOut(yield* home)
      yield* fake.provide(
        Effect.gen(function* () {
          yield* Layer.build(Subscriptions.layer.pipe(Layer.provide(fake.layer)))
          yield* TestClock.adjust("1 second")
          assert.strictEqual(fake.spawned.length, 1)
          yield* TestClock.adjust("1 hour")
          assert.strictEqual(fake.spawned.length, 1)
        }),
      )
    }),
  )

  it.effect("a read a minute after the last poll refreshes once, shared by two readers at once", () =>
    Effect.gen(function* () {
      const fake = loggedOut(yield* home)
      yield* fake.provide(
        Effect.gen(function* () {
          const context = yield* Layer.build(Subscriptions.layer.pipe(Layer.provide(fake.layer)))
          const subs = Context.get(context, Subscriptions)
          yield* TestClock.adjust("59 seconds")
          yield* subs.list
          assert.strictEqual(fake.spawned.length, 1)
          yield* TestClock.adjust("1 second")
          const [one, two] = yield* Effect.all([subs.list, subs.list], { concurrency: "unbounded" })
          assert.strictEqual(fake.spawned.length, 2)
          assert.deepStrictEqual(one, two)
          assert.strictEqual(one[0]?.account.kind, "none")
          yield* subs.list
          assert.strictEqual(fake.spawned.length, 2)
        }),
      )
    }),
  )

  it.effect("a plugin report is what agent.start.before receives", () =>
    Effect.gen(function* () {
      const limits = [{ window: "monthly", percent: 3, status: "limited" as const, resetTime: 9 }]
      let seen: unknown
      const plugin = Plugin.define({
        id: "see",
        effect: (ctx) =>
          Effect.gen(function* () {
            yield* ctx.subscription.report({ harness: "claude", provider: "example-proxy", limits })
            yield* ctx.agent.hook("start.before", (event) =>
              Effect.sync(() => {
                seen = event.subscriptions
              }),
            )
          }),
      })
      const listed = yield* Effect.gen(function* () {
        const subs = yield* Subscriptions
        const plugins = yield* Plugins.make([{ source: "see", revision: "-", options: {}, plugin }])
        yield* plugins.start({
          project: "/r",
          agent: "general",
          parentSessionId: undefined,
          prompt: "go",
          harness: "pi",
          provider: undefined,
          model: undefined,
          machine: { id: "local" },
          runtime: undefined,
          parentRuntime: undefined,
          machines: [],
          attempts: [],
          harnesses: [{ harness: "pi", available: true }],
        })
        return { seen, list: yield* subs.list }
      }).pipe(
        Effect.provide(subscriptionsLayer),
        Effect.provide(harnessesLayer()),
        Effect.provide(runtimesLayer),
        Effect.provide(agentsLayer),
        Effect.provide(Bus.layer),
        Effect.scoped,
      )
      assert.deepStrictEqual(listed.seen, listed.list)
      assert.deepStrictEqual(listed.list[0]?.limits, limits)
      assert.strictEqual(listed.list[0]?.provider, "example-proxy")
    }),
  )

  it.effect(
    "vibest subscriptions prints the current set as JSON",
    () =>
      Effect.gen(function* () {
        const layout = yield* Layout
        const repo = yield* makeRepository
        yield* (yield* Subscriptions).report({
          harness: "pi",
          provider: "example-proxy",
          limits: [{ window: "monthly", percent: 12, status: "available", resetTime: null }],
        })
        const run = yield* runVibest(repo, { HOME: layout.home, VIBEST_HOME: layout.home }, ["subscriptions"])
        assert.strictEqual(run.code, 0, run.stderr)
        assert.deepStrictEqual(JSON.parse(run.stdout), [
          {
            harness: "pi",
            provider: "example-proxy",
            machine: "local",
            account: { kind: "none" },
            limits: [{ window: "monthly", percent: 12, status: "available", resetTime: null }],
            updatedAt: 0,
          },
        ])
      }).pipe(Effect.provide(served)),
    30_000,
  )
})
