import net from "node:net"

import { assert, layer } from "@effect/vitest"
import { HOOK_TIMEOUT } from "@vibest/client/client"
import { claude } from "@vibest/core/harnesses/claude"
import { cursor } from "@vibest/core/harnesses/cursor"
import { Layout } from "@vibest/core/paths"
import { PROTOCOL, PROTOCOL_HEADER } from "@vibest/protocol/protocol"
import { ConfigProvider, Duration, Effect, Fiber, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"
import { beforeEach, vi } from "vitest"

import * as Platform from "#platform"

import { integrationPrompt, integrationStop } from "../src/cli.ts"
import { runVibest, tempDirectory, until } from "./fakes.ts"

const statusReports = vi.hoisted(() => [] as Array<string>)
vi.mock("@vibest/core/results", async (importOriginal) => {
  const results = await importOriginal<typeof import("@vibest/core/results")>()
  return {
    ...results,
    writeTerminalStatus: (...[state]: Parameters<typeof results.writeTerminalStatus>) =>
      Effect.sync(() => {
        statusReports.push(state)
      }),
  }
})
beforeEach(() => {
  statusReports.length = 0
})

const stopAt = (home: string, env: Record<string, string>, raw: string) =>
  integrationStop(claude, raw).pipe(
    Effect.provideServiceEffect(Layout, Layout.make(home)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    TestClock.withLive,
  )

const listen = (sock: string, lines: string[], answer: (n: number) => true | "drop" | "hang" = () => true) => {
  const server = net.createServer((socket) => {
    let buf = ""
    socket.on("data", (chunk) => {
      buf += chunk.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const line = buf.slice(0, nl)
      lines.push(line)
      const how = answer(lines.length)
      if (how === "drop") return socket.destroy()
      if (how === "hang") return
      let id: unknown
      try {
        id = (JSON.parse(line) as { id?: unknown }).id
      } catch {
        socket.end()
        return
      }
      socket.end(JSON.stringify({ jsonrpc: "2.0", id, result: null }) + "\n")
    })
  })
  return Effect.acquireRelease(
    Effect.promise(
      () =>
        new Promise<net.Server>((resolve, reject) => {
          server.once("error", reject)
          server.listen(sock, () => resolve(server))
        }),
    ),
    () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
  )
}

const rpc = (lines: readonly string[]) =>
  lines.flatMap((line) => {
    const message = JSON.parse(line) as {
      jsonrpc?: unknown
      method?: string
      params?: unknown
      headers?: unknown
      id?: unknown
      traceId?: unknown
      spanId?: unknown
      sampled?: unknown
    }
    return message.method && !message.method.startsWith("@effect/") ? [message] : []
  })

const event = { hook_event_name: "TurnComplete", session_id: "c1", reason: "answer", last_assistant_message: "done" }
const promptEvent = { hook_event_name: "PromptSubmit", text: "look here", origin: "composer" }

const promptAt = (home: string, env: Record<string, string>, raw: string) =>
  integrationPrompt(claude, raw).pipe(
    Effect.provideServiceEffect(Layout, Layout.make(home)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    TestClock.withLive,
  )

layer(Platform.services)("claude integration stop", (it) => {
  it.effect("a worker sends its event verbatim as TurnEnd with the session's headers and writes no file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const started = Date.now()
      yield* stopAt(home, { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }, JSON.stringify(event))
      assert.isBelow(Date.now() - started, 2_000)
      assert.isFalse(yield* fs.exists(path.join(home, "results")))
      assert.isFalse(yield* fs.exists(path.join(home, "reports")))
      const [request] = rpc(lines)
      assert.deepStrictEqual(request, {
        jsonrpc: "2.0",
        method: "TurnEnd",
        params: { sessionId: "w1", harness: "claude", event: JSON.stringify(event) },
        id: request?.id,
        headers: request?.headers,
        traceId: (request as { traceId?: unknown }).traceId,
        spanId: (request as { spanId?: unknown }).spanId,
        sampled: (request as { sampled?: unknown }).sampled,
      })
      assert.deepInclude(Object.fromEntries(request?.headers as Array<[string, string]>), {
        [PROTOCOL_HEADER]: String(PROTOCOL),
        "vibest-caller": "session",
        "vibest-session-id": "w1",
        "vibest-agent": "general",
      })
    }),
  )

  it.effect("a down vibestd: nothing is written and no daemon is started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const started = Date.now()
      yield* stopAt(home, { VIBEST_AGENT: "session", VIBEST_SESSION_ID: "w1" }, JSON.stringify(event))
      assert.isBelow(Date.now() - started, 2_000)
      assert.isFalse(yield* fs.exists(path.join(home, "results")))
      assert.isFalse(yield* fs.exists(path.join(home, "vibestd.log")))
      assert.isFalse(yield* fs.exists(path.join(home, "vibestd.pid")))
      assert.isFalse(yield* fs.exists(path.join(home, "vibest.sock")))
    }),
  )

  it.effect(
    "only a connection that could not be made is tried again: a dropped or unanswered one may have been handled, so it is not",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
        const late = yield* tempDirectory("l-")
        const retried: string[] = []
        const sending = yield* Effect.forkChild(stopAt(late, worker, JSON.stringify(event)))
        yield* TestClock.withLive(Effect.sleep("100 millis"))
        yield* listen(path.join(late, "vibest.sock"), retried)
        yield* Fiber.join(sending)
        assert.deepStrictEqual(
          rpc(retried).map((r) => r.method),
          ["TurnEnd"],
        )
        const dropped = yield* tempDirectory("d-")
        const seen: string[] = []
        yield* listen(path.join(dropped, "vibest.sock"), seen, (n) => (n === 1 ? "drop" : true))
        yield* stopAt(dropped, worker, JSON.stringify(event))
        assert.deepStrictEqual(
          rpc(seen).map((r) => r.method),
          ["TurnEnd"],
        )
        const hung = yield* tempDirectory("h-")
        const once: string[] = []
        yield* listen(path.join(hung, "vibest.sock"), once, () => "hang")
        const started = Date.now()
        yield* stopAt(hung, worker, JSON.stringify(event))
        assert.isAtLeast(Date.now() - started, Duration.toMillis(HOOK_TIMEOUT) - 100)
        assert.deepStrictEqual(
          rpc(once).map((r) => r.method),
          ["TurnEnd"],
        )
      }),
  )

  it.effect("a coordinator's turn end writes no result file and sends nothing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      yield* stopAt(
        home,
        { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "L" },
        JSON.stringify({ ...event, reason: "aborted" }),
      )
      assert.isFalse(yield* fs.exists(path.join(home, "results")))
      assert.deepStrictEqual(lines, [])
    }),
  )

  it.effect(
    "invalid input, a classic event, a foreign event, a missing harness id, and a path-like session id do nothing",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const home = yield* tempDirectory("s-")
        const lines: string[] = []
        yield* listen(path.join(home, "vibest.sock"), lines)
        const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
        const coordinator = { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "L" }
        for (const [env, raw] of [
          [{}, JSON.stringify(event)],
          [{ VIBEST_AGENT: "general" }, JSON.stringify(event)],
          [{ VIBEST_SESSION_ID: "w1" }, JSON.stringify(event)],
          [worker, ""],
          [worker, "not json"],
          [worker, "[]"],
          [worker, "null"],
          [worker, JSON.stringify({ ...event, hook_event_name: "Stop" })],
          [worker, JSON.stringify({ ...event, hook_event_name: "StopFailure", error: "rate_limit" })],
          [worker, JSON.stringify({ hook_event_name: "PreToolUse", session_id: "c1" })],
          [worker, JSON.stringify({ session_id: "c1" })],
          [coordinator, JSON.stringify({ hook_event_name: "TurnComplete" })],
          [coordinator, JSON.stringify({ hook_event_name: "TurnComplete", session_id: "" })],
          [coordinator, "not json"],
        ] as const) {
          yield* stopAt(home, env, raw)
        }
        assert.deepStrictEqual(lines, [])
        assert.isFalse(yield* fs.exists(path.join(home, "results")))
        assert.isFalse(yield* fs.exists(path.join(home, "evil.json")))
        assert.strictEqual(Duration.toMillis(HOOK_TIMEOUT), 2_000)
      }),
  )

  it.effect("the CLI entrypoint sends TurnEnd, and a down daemon is not started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const env = { HOME: home, VIBEST_HOME: home, VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
      const ran = yield* runVibest(home, env, ["integration", "stop", "--harness", "claude"], JSON.stringify(event))
      assert.strictEqual(ran.code, 0, ran.stderr)
      assert.strictEqual(ran.stdout, "")
      assert.deepStrictEqual(
        rpc(lines).map((r) => [r.method, r.params]),
        [["TurnEnd", { sessionId: "w1", harness: "claude", event: JSON.stringify(event) }]],
      )

      const quiet = yield* tempDirectory("q-")
      const started = Date.now()
      const down = yield* runVibest(
        quiet,
        { HOME: quiet, VIBEST_HOME: quiet, VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" },
        ["integration", "stop", "--harness", "claude"],
        JSON.stringify(event),
      )
      assert.isBelow(Date.now() - started, 4_000, down.stderr)
      assert.strictEqual(down.code, 0, down.stderr)
      assert.isFalse(yield* fs.exists(path.join(quiet, "results")))
      assert.isFalse(yield* fs.exists(path.join(quiet, "vibestd.log")))
      assert.isFalse(yield* fs.exists(path.join(quiet, "vibestd.pid")))

      const skipped = yield* runVibest(
        quiet,
        { HOME: quiet, VIBEST_HOME: quiet },
        ["integration", "stop", "--harness", "claude"],
        "not json",
      )
      assert.strictEqual(skipped.code, 0, skipped.stderr)
    }),
  )

  it.effect("a prompt the person submitted notifies Prompt; the coordinator and any other origin do not", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* tempDirectory("p-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
      yield* promptAt(home, worker, JSON.stringify(promptEvent))
      assert.deepStrictEqual(
        rpc(lines).map((r) => [r.method, r.params]),
        [["Prompt", { sessionId: "w1", harness: "claude", event: JSON.stringify(promptEvent) }]],
      )
      for (const [env, raw] of [
        [{ VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "w1" }, JSON.stringify(promptEvent)],
        [worker, JSON.stringify({ ...promptEvent, origin: "task-notification" })],
        [worker, JSON.stringify({ ...promptEvent, origin: "plugin" })],
        [worker, JSON.stringify({ ...promptEvent, text: "  " })],
        [worker, JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "look here", source: "user" })],
        [{}, JSON.stringify(promptEvent)],
        [worker, "not json"],
      ] as const) {
        yield* promptAt(home, env, raw)
      }
      assert.strictEqual(rpc(lines).length, 1)
    }),
  )

  it.effect("Cursor reports working before a held Prompt RPC completes", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* tempDirectory("c-")
      const lines: Array<string> = []
      yield* listen(path.join(home, "vibest.sock"), lines, () => "hang")
      const sending = yield* integrationPrompt(
        cursor,
        JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "go" }),
      ).pipe(
        Effect.provideServiceEffect(Layout, Layout.make(home)),
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" })),
        ),
        Effect.forkChild,
      )
      yield* until(
        Effect.sync(() => rpc(lines).length),
        (n) => n === 1,
      )
      assert.deepStrictEqual(statusReports, ["working"])
      yield* Fiber.interrupt(sending)
    }),
  )

  it.effect("Cursor reports idle only for accepted response/stop events and never guesses blocked", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* tempDirectory("c-")
      const lines: Array<string> = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
      const invoke = (stop: boolean, raw: string, env: Record<string, string> = worker) =>
        (stop ? integrationStop(cursor, raw) : integrationPrompt(cursor, raw)).pipe(
          Effect.provideServiceEffect(Layout, Layout.make(home)),
          Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
        )
      for (const event of [
        { hook_event_name: "afterAgentResponse", text: "done" },
        { hook_event_name: "stop", status: "aborted" },
      ])
        yield* invoke(true, JSON.stringify(event))
      assert.deepStrictEqual(statusReports, ["idle", "idle"])
      statusReports.length = 0
      for (const stop of [false, true]) {
        for (const raw of [
          "",
          "null",
          "[]",
          "broken",
          JSON.stringify({ hook_event_name: "preToolUse" }),
          JSON.stringify({ hook_event_name: "stop", status: "completed" }),
          JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: " " }),
        ])
          yield* invoke(stop, raw)
        const raw = JSON.stringify(
          stop ? { hook_event_name: "afterAgentResponse" } : { hook_event_name: "beforeSubmitPrompt", prompt: "go" },
        )
        for (const env of [
          {},
          { VIBEST_AGENT: "general" },
          { VIBEST_SESSION_ID: "w1" },
          { ...worker, VIBEST_AGENT: "coordinator" },
        ])
          yield* invoke(stop, raw, env)
      }
      assert.deepStrictEqual(statusReports, [])
      assert.strictEqual(rpc(lines).length, 2)
    }),
  )

  it.effect("Cursor's hook sends its conversation id with the session's headers", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* tempDirectory("c-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const env = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1", VIBEST_PROJECT_ID: "7", VIBEST_HARNESS: "cursor" }
      const raw = JSON.stringify({ hook_event_name: "beforeSubmitPrompt", prompt: "go", conversation_id: "conv-1" })
      yield* integrationPrompt(cursor, raw).pipe(
        Effect.provideServiceEffect(Layout, Layout.make(home)),
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
      )
      const [request] = rpc(lines)
      assert.deepInclude(Object.fromEntries(request?.headers as Array<[string, string]>), {
        "vibest-session-id": "w1",
        "vibest-project-id": "7",
        "vibest-harness": "cursor",
        "vibest-harness-session-id": "conv-1",
      })
    }),
  )
})
