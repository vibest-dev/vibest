import { assert, describe, it } from "@effect/vitest"
import { Bus } from "@vibest/core/bus"
import { Harness, HarnessUnavailable } from "@vibest/core/harness"
import { Layout } from "@vibest/core/paths"
import { Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Plugin } from "@vibest/plugin"
import { claude, cursor, pi } from "@vibest/plugin-harnesses"
import { keychainProblem } from "@vibest/plugin-harnesses/cursor"
import { CLAUDE_CREDENTIALS, CURSOR_ACCESS_TOKEN, Secrets } from "@vibest/plugin-harnesses/keychain"
import { claudeSubscription } from "@vibest/plugin-harnesses/subscriptions/claude"
import { cursorSubscription } from "@vibest/plugin-harnesses/subscriptions/cursor"
import { piSubscription } from "@vibest/plugin-harnesses/subscriptions/pi"
import * as Server from "@vibest/server/server"
import {
  ByteSize,
  ConfigProvider,
  Context,
  Effect,
  Fiber,
  FileSystem,
  Layer,
  Logger,
  Option,
  Path,
  Stream,
} from "effect"
import { Sink } from "effect"
import { Headers, HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { runtimesLayer, subscriptionsLayer, harnessesLayer, makeRepository, runVibest, testLayer } from "./fakes.ts"

const CLAUDE_SECRET = "claude-token-do-not-log"
const CURSOR_SECRET = "cursor-token-do-not-log"
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
  readonly passwords?: Readonly<Record<string, string>>
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
    Layer.succeed(Secrets, { password: (service) => Effect.succeed(options.passwords?.[service]) }),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
    options.fileSystem === undefined ? Layer.empty : Layer.succeed(FileSystem.FileSystem, options.fileSystem),
  )
  const onMachine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(machine), Effect.provide(Platform.services), Effect.orDie)
  const definitions = [
    { ...claude, subscription: (dir: string) => onMachine(claudeSubscription(dir)) },
    {
      ...cursor,
      subscription: (dir: string) =>
        onMachine(Effect.flatMap(keychainProblem(dir), (problem) => cursorSubscription(dir, problem))),
    },
    { ...pi, subscription: (dir: string) => onMachine(piSubscription(dir)) },
  ]
  const fakes = Subscriptions.layer.pipe(
    Layer.provideMerge(harnessesLayer(definitions)),
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

const clockSafeKeychain = FileSystem.makeNoop({
  stat: () =>
    Effect.succeed({
      type: "File",
      mtime: Option.none(),
      atime: Option.none(),
      birthtime: Option.none(),
      dev: 0,
      ino: Option.none(),
      mode: 0,
      nlink: Option.none(),
      uid: Option.none(),
      gid: Option.none(),
      rdev: Option.none(),
      size: ByteSize.zero,
      blksize: Option.none(),
      blocks: Option.none(),
    }),
})

describe("subscription polls and vibest subscriptions over fake CLIs, keychain and HTTP: nothing touches the network", () => {
  it.effect("an expired or missing token skips the endpoint and keeps the last limits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
      yield* fs.makeDirectory(path.join(dir, "Library", "Keychains"), { recursive: true })
      yield* fs.writeFileString(
        path.join(dir, "Library", "Keychains", "login.keychain-db"),
        "fake keychain; no real CLI",
      )
      const agent = path.join(dir, ".pi", "agent")
      yield* fs.makeDirectory(agent, { recursive: true })
      yield* fs.writeFileString(
        path.join(agent, "auth.json"),
        JSON.stringify({ "example-proxy": { type: "api_key", key: PI_SECRET } }),
      )
      yield* fs.writeFileString(
        path.join(agent, "models.json"),
        JSON.stringify({ providers: { "custom-proxy": { models: [] } } }),
      )
      yield* fs.writeFileString(path.join(agent, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }))
      const commands: Record<string, string> = {
        "claude auth status --json": claudeStatus,
        "cursor-agent status --format json": JSON.stringify({ isAuthenticated: true }),
        "cursor-agent about --format json": JSON.stringify({ subscriptionTier: "Ultra" }),
        "pi auth check --provider example-proxy --json --no-refresh": JSON.stringify({
          status: "ready",
          provider: "example-proxy",
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
        passwords: {
          [CLAUDE_CREDENTIALS]: JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_SECRET, expiresAt: 0 } }),
          [CURSOR_ACCESS_TOKEN]: "",
        },
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
          ["claude", "", "subscription", "max", "token expired", 1],
          ["cursor", "", "subscription", "Ultra", "token unreadable", 2],
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

  it.effect("a usage response replaces plugin limits; a hung CLI and a non-200 do not", () =>
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
        passwords: {
          [CLAUDE_CREDENTIALS]: JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_SECRET, expiresAt: 9e12 } }),
          [CURSOR_ACCESS_TOKEN]: CURSOR_SECRET,
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
      assert.deepStrictEqual(listed.find((row) => row.harness === "claude")?.limits, [
        { window: "5h", percent: 4, status: "available", resetTime: Date.parse("2026-10-31T17:20:00.296Z") },
        { window: "7d", percent: 100, status: "limited", resetTime: Date.parse("2026-11-01T21:00:00.296Z") },
      ])
      assert.strictEqual(listed.find((row) => row.harness === "cursor")?.limits[0]?.percent, 35.891)
      assert.deepStrictEqual(
        fresh.requests.map((r) => r.authorization).sort(),
        [`Bearer ${CLAUDE_SECRET}`, `Bearer ${CURSOR_SECRET}`, `Bearer ${CURSOR_SECRET}`].sort(),
      )
      assert.notInclude(JSON.stringify({ logs: fresh.logs, listed }), CLAUDE_SECRET)
      assert.notInclude(JSON.stringify(listed), CURSOR_SECRET)

      const denied = fakeMachine({
        installed: ["claude"],
        home: dir,
        commands: { "claude auth status --json": claudeStatus },
        passwords: {
          [CLAUDE_CREDENTIALS]: JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE_SECRET, expiresAt: 9e12 } }),
        },
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
      assert.strictEqual(kept.error, "usage endpoint answered 401")
      assert.strictEqual(kept.limits[0]?.percent, 9)
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

  it.effect("Cursor subscription probes skip an empty macOS Keychains directory before spawning", () =>
    Effect.gen(function* () {
      if (process.platform !== "darwin") return
      const dir = yield* home
      yield* Effect.flatMap(FileSystem.FileSystem, (fs) =>
        fs.makeDirectory(`${dir}/Library/Keychains`, { recursive: true }),
      ).pipe(Effect.provide(Platform.services))
      const fake = fakeMachine({ installed: ["cursor"], home: dir, commands: {} })
      const rows = yield* fake.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          yield* subs.poll
          return yield* subs.list
        }),
      )
      assert.include(rows[0]?.error, "Library/Keychains")
      assert.deepStrictEqual(fake.spawned, [])
      assert.deepStrictEqual(fake.requests, [])
    }),
  )

  it.effect("a failed GetHardLimit is an error and does not mark Cursor limited", () =>
    Effect.gen(function* () {
      const dir = yield* home
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.makeDirectory(`${dir}/Library/Keychains`, { recursive: true })
        yield* fs.writeFileString(`${dir}/Library/Keychains/login.keychain-db`, "fake keychain; no real CLI")
      }).pipe(Effect.provide(Platform.services))
      const fake = fakeMachine({
        installed: ["cursor"],
        home: dir,
        commands: {
          "cursor-agent status --format json": JSON.stringify({ isAuthenticated: true }),
          "cursor-agent about --format json": JSON.stringify({ subscriptionTier: "Ultra" }),
        },
        passwords: { [CURSOR_ACCESS_TOKEN]: CURSOR_SECRET },
        http: {
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage": {
            status: 200,
            body: {
              billingCycleEnd: "1794886804000",
              planUsage: { totalPercentUsed: 100, autoPercentUsed: 10, apiPercentUsed: 10, limit: 40000 },
            },
          },
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit": { status: 500, body: {} },
        },
      })
      const row = yield* fake.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          yield* subs.poll
          return (yield* subs.list).find((entry) => entry.harness === "cursor")!
        }),
      )
      assert.include(row.error ?? "", "GetHardLimit")
      assert.strictEqual(
        row.limits.some((limit) => limit.status === "limited"),
        false,
      )
    }),
  )

  it.effect("a failed GetHardLimit and a failed usage request keep both errors", () =>
    Effect.gen(function* () {
      const usageUrl = "https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage"
      const fake = fakeMachine({
        installed: ["cursor"],
        home: yield* home,
        commands: {
          "cursor-agent status --format json": JSON.stringify({ isAuthenticated: true }),
          "cursor-agent about --format json": JSON.stringify({ subscriptionTier: "Ultra" }),
        },
        passwords: { [CURSOR_ACCESS_TOKEN]: CURSOR_SECRET },
        http: {
          "https://api2.cursor.sh/aiserver.v1.DashboardService/GetHardLimit": { status: 500, body: {} },
        },
        httpHang: [usageUrl],
        fileSystem: clockSafeKeychain,
      })
      const row = yield* fake.provide(
        Effect.gen(function* () {
          const subs = yield* Subscriptions
          const pending = yield* Effect.forkChild(subs.poll)
          yield* TestClock.adjust("10 seconds")
          yield* Fiber.join(pending)
          return (yield* subs.list).find((entry) => entry.harness === "cursor")!
        }),
      )
      assert.include(row.error ?? "", "GetHardLimit answered 500")
      assert.include(row.error ?? "", "usage endpoint failed")
    }),
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
        Subscriptions.layer.pipe(
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
          yield* Layer.build(Subscriptions.live.pipe(Layer.provide(fake.layer)))
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
          const context = yield* Layer.build(Subscriptions.live.pipe(Layer.provide(fake.layer)))
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
          agentType: "general",
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
