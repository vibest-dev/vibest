// `vibest integration stop`: Claude's native Stop / StopFailure bridge. Isolated HOME, fake socket, no live daemon.
import net from "node:net"

import { assert, layer } from "@effect/vitest"
import { claude } from "@vibest/core/harnesses/claude"
import { Layout } from "@vibest/core/paths"
import { PROTOCOL, PROTOCOL_HEADER } from "@vibest/protocol/protocol"
import { ConfigProvider, Duration, Effect, FileSystem, Path } from "effect"

import * as Platform from "#platform"

import { COORDINATOR_REPORT_TIMEOUT, integrationPrompt, integrationStop, RESULT_READY_TIMEOUT } from "../src/cli.ts"
import { runVibest, tempDirectory } from "./fakes.ts"

const stopAt = (home: string, env: Record<string, string>, raw: string) =>
  integrationStop(claude, raw).pipe(
    Effect.provideServiceEffect(Layout, Layout.make(home)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  )

const listen = (sock: string, lines: string[]) => {
  const server = net.createServer((socket) => {
    let buf = ""
    socket.on("data", (chunk) => {
      buf += chunk.toString()
      const nl = buf.indexOf("\n")
      if (nl < 0) return
      const line = buf.slice(0, nl)
      lines.push(line)
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

const event = { hook_event_name: "Stop", session_id: "c1", last_assistant_message: "done" }
const promptEvent = { hook_event_name: "UserPromptSubmit", session_id: "c1", prompt: "look here", source: "user" }

const promptAt = (home: string, env: Record<string, string>, raw: string) =>
  integrationPrompt(claude, raw).pipe(
    Effect.provideServiceEffect(Layout, Layout.make(home)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  )

layer(Platform.services)("claude integration stop", (it) => {
  it.effect("a worker writes the envelope, then notifies with protocol headers only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const started = Date.now()
      yield* stopAt(home, { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }, JSON.stringify(event))
      assert.isBelow(Date.now() - started, 2_000)
      const file = path.join(home, "results", "w1.json")
      const envelope = JSON.parse(yield* fs.readFileString(file)) as { harness: string; ts: number; payload: unknown }
      assert.strictEqual(envelope.harness, "claude")
      assert.deepStrictEqual(envelope.payload, event)
      assert.isTrue(Number.isInteger(envelope.ts) && Math.abs(envelope.ts - Math.floor(Date.now() / 1000)) < 5)
      const [request] = rpc(lines)
      assert.deepStrictEqual(request, {
        jsonrpc: "2.0",
        method: "ResultReady",
        params: { sessionId: "w1" },
        id: request?.id,
        headers: [[PROTOCOL_HEADER, String(PROTOCOL)]],
        traceId: (request as { traceId?: unknown }).traceId,
        spanId: (request as { spanId?: unknown }).spanId,
        sampled: (request as { sampled?: unknown }).sampled,
      })
      assert.deepStrictEqual(request?.headers, [[PROTOCOL_HEADER, String(PROTOCOL)]])
    }),
  )

  it.effect("keeps the worker file when vibestd is down and does not start a daemon", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const started = Date.now()
      yield* stopAt(home, { VIBEST_AGENT: "session", VIBEST_SESSION_ID: "w1" }, JSON.stringify(event))
      assert.isBelow(Date.now() - started, 2_000)
      assert.isTrue(yield* fs.exists(path.join(home, "results", "w1.json")))
      assert.isFalse(yield* fs.exists(path.join(home, "vibestd.log")))
      assert.isFalse(yield* fs.exists(path.join(home, "vibestd.pid")))
      assert.isFalse(yield* fs.exists(path.join(home, "vibest.sock")))
    }),
  )

  it.effect("a coordinator reports the harness session and writes no result file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      yield* stopAt(
        home,
        { VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "L" },
        JSON.stringify({ ...event, hook_event_name: "StopFailure" }),
      )
      assert.isFalse(yield* fs.exists(path.join(home, "results")))
      assert.deepStrictEqual(
        rpc(lines).map((r) => [r.method, r.params]),
        [["CoordinatorSessionReady", { sessionId: "L", harness: "claude", harnessSessionId: "c1" }]],
      )
    }),
  )

  it.effect(
    "invalid input, a subagent, a foreign event, a missing harness id, and a path-like session id do nothing",
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
          [worker, JSON.stringify({ ...event, agent_id: "sub" })],
          [worker, JSON.stringify({ hook_event_name: "PreToolUse", session_id: "c1" })],
          [worker, JSON.stringify({ session_id: "c1" })],
          [coordinator, JSON.stringify({ hook_event_name: "Stop" })],
          [coordinator, JSON.stringify({ hook_event_name: "Stop", session_id: "" })],
          [coordinator, "not json"],
          [{ ...worker, VIBEST_SESSION_ID: "../evil" }, JSON.stringify(event)],
        ] as const) {
          yield* stopAt(home, env, raw)
        }
        assert.deepStrictEqual(lines, [])
        assert.isFalse(yield* fs.exists(path.join(home, "results")))
        assert.isFalse(yield* fs.exists(path.join(home, "evil.json")))
        assert.strictEqual(Duration.toMillis(RESULT_READY_TIMEOUT), 500)
        assert.strictEqual(Duration.toMillis(COORDINATOR_REPORT_TIMEOUT), 2_000)
      }),
  )

  it.effect(
    "the CLI entrypoint writes then notifies, and a down daemon still leaves the file without starting vibestd",
    () =>
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
        const envelope = JSON.parse(yield* fs.readFileString(path.join(home, "results", "w1.json"))) as {
          harness: string
          payload: unknown
        }
        assert.deepStrictEqual([envelope.harness, envelope.payload], ["claude", event])
        assert.strictEqual(rpc(lines)[0]?.method, "ResultReady")

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
        assert.isTrue(yield* fs.exists(path.join(quiet, "results", "w1.json")))
        assert.isFalse(yield* fs.exists(path.join(quiet, "vibestd.log")))
        assert.isFalse(yield* fs.exists(path.join(quiet, "vibestd.pid")))

        const skipped = yield* runVibest(
          quiet,
          { HOME: quiet, VIBEST_HOME: quiet },
          ["integration", "stop", "--harness", "claude"],
          "not json",
        )
        assert.strictEqual(skipped.code, 0, skipped.stderr)
        assert.deepStrictEqual(yield* fs.readDirectory(path.join(quiet, "results")), ["w1.json"])
      }),
  )

  it.effect("a user prompt notifies Prompt; the coordinator, a nested agent, and a non-user source do not", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* tempDirectory("p-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
      yield* promptAt(home, worker, JSON.stringify(promptEvent))
      assert.deepStrictEqual(
        rpc(lines).map((r) => [r.method, r.params]),
        [["Prompt", { sessionId: "w1", text: "look here" }]],
      )
      for (const [env, raw] of [
        [{ VIBEST_AGENT: "coordinator", VIBEST_SESSION_ID: "w1" }, JSON.stringify(promptEvent)],
        [worker, JSON.stringify({ ...promptEvent, agent_id: "sub" })],
        [worker, JSON.stringify({ ...promptEvent, source: "system" })],
        [worker, JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "  " })],
        [{}, JSON.stringify(promptEvent)],
        [worker, "not json"],
      ] as const) {
        yield* promptAt(home, env, raw)
      }
      assert.strictEqual(rpc(lines).length, 1)
    }),
  )
})
