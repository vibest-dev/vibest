// Subscription polls and `vibest subscriptions`. CLIs, the keychain and HTTP are fakes: nothing here touches the network.
import { assert, describe, it } from "@effect/vitest"
import { Harness, HarnessUnavailable } from "@vibest/core/harness"
import { CLAUDE_CREDENTIALS, CURSOR_ACCESS_TOKEN, Keychain, securityArgs } from "@vibest/core/keychain"
import { Layout } from "@vibest/core/paths"
import { Plugins } from "@vibest/core/plugins"
import { Project } from "@vibest/core/project"
import { Runtimes } from "@vibest/core/runtimes"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { Plugin } from "@vibest/plugin"
import * as Server from "@vibest/server/server"
import { ConfigProvider, Effect, Fiber, FileSystem, Layer, Logger, Option, Path, Stream } from "effect"
import { Sink } from "effect"
import { Headers, HttpClient, HttpClientResponse } from "effect/http"
import { ChildProcessSpawner } from "effect/process"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { makeRepository, runVibest, testLayer } from "./fakes.ts"

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

/** One fake machine. `hang` names commands (`claude auth status --json`) that never exit. */
const world = (options: {
  readonly installed: ReadonlyArray<string>
  readonly commands: Readonly<Record<string, string>>
  readonly hang?: ReadonlyArray<string>
  readonly passwords?: Readonly<Record<string, string>>
  readonly http?: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>
  readonly home: string
}) => {
  const spawned: Array<Spawned> = []
  const requests: Array<{ readonly url: string; readonly authorization: string | undefined }> = []
  const logs: Array<unknown> = []
  const hanging = new Set(options.hang ?? [])
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
    const hit = options.http?.[request.url] ?? { status: 599, body: {} }
    return Effect.succeed(
      HttpClientResponse.fromWeb(request, new Response(JSON.stringify(hit.body), { status: hit.status })),
    )
  })
  // The fake spawner is inside Platform.services so it wins: poll must not run the real CLIs.
  const layer = Layer.mergeAll(
    Subscriptions.layer,
    harnessLayer(options.installed),
    Layer.succeed(Keychain, { password: (service) => Effect.succeed(options.passwords?.[service]) }),
    Layer.succeed(HttpClient.HttpClient, http),
    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
  )
  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.provide(Platform.services),
      Effect.provide(Logger.layer([Logger.make((entry) => void logs.push(entry.message))])),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ HOME: options.home, PI_CODING_AGENT_DIR: `${options.home}/.pi/agent` }),
        ),
      ),
    )
  return { spawned, requests, logs, layer, provide }
}

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const home = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.makeTempDirectoryScoped({ prefix: "vibest-subs-" })
}).pipe(Effect.provide(Platform.services), Effect.orDie)

describe("subscriptions", () => {
  it("the macOS keychain read is security find-generic-password -w", () => {
    assert.deepStrictEqual(
      [...securityArgs(CLAUDE_CREDENTIALS)],
      ["security", "find-generic-password", "-s", CLAUDE_CREDENTIALS, "-w"],
    )
    assert.deepStrictEqual(
      [...securityArgs(CURSOR_ACCESS_TOKEN)],
      ["security", "find-generic-password", "-s", CURSOR_ACCESS_TOKEN, "-w"],
    )
  })

  it.effect("an expired or missing token skips the endpoint and keeps the last limits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* home
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
      const fake = world({
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
      const fresh = world({
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

      const denied = world({
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

      const hung = world({
        installed: ["claude"],
        home: dir,
        commands: {},
        hang: ["claude auth status --json"],
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
    }),
  )

  it.effect("while vibestd runs, an installed harness is polled at most once a minute", () =>
    Effect.gen(function* () {
      const dir = yield* home
      const fake = world({
        installed: ["claude"],
        home: dir,
        commands: { "claude auth status --json": JSON.stringify({ loggedIn: false }) },
      })
      const polling = Subscriptions.live.pipe(Layer.provide(fake.layer))
      yield* fake.provide(
        Effect.gen(function* () {
          yield* Layer.build(polling)
          yield* TestClock.adjust("59 seconds")
          assert.strictEqual(fake.spawned.length, 1)
          yield* TestClock.adjust("1 second")
          assert.strictEqual(fake.spawned.length, 2)
          assert.deepStrictEqual(
            fake.spawned.map((spawn) => spawn.command),
            ["claude", "claude"],
          )
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
          harness: undefined,
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
      }).pipe(Effect.provide(Subscriptions.layer), Effect.provide(Runtimes.layer), Effect.scoped)
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
