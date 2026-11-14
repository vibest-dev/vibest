import net from "node:net"

import { assert, layer } from "@effect/vitest"
import { HOOK_RETRY_DELAY } from "@vibest/client/client"
import { PROTOCOL_HEADER } from "@vibest/protocol/protocol"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { ConfigProvider, Effect, Exit, Fiber, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

import { integrationPrompt, integrationReady, integrationStop } from "../src/integration.ts"
import { tempDirectory, untilVirtual } from "./fakes.ts"

const stopAt = (home: string, env: Record<string, string>, raw: string) =>
  integrationStop("claude", raw).pipe(
    Effect.provideServiceEffect(Layout, Layout.make(home)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
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
      let request: { id?: unknown; method?: unknown }
      try {
        request = JSON.parse(line) as { id?: unknown; method?: unknown }
      } catch {
        socket.end()
        return
      }
      const result = request.method === "Session.Ready" ? {} : null
      socket.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n")
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

const event = {
  hook_event_name: "ExecutionComplete",
  session_id: "c1",
  reason: "answer",
  last_assistant_message: "done",
}
const promptEvent = { hook_event_name: "PromptSubmit", text: "look here", origin: "composer" }

const promptAt = (home: string, env: Record<string, string>, raw: string) =>
  integrationPrompt("claude", raw).pipe(
    Effect.provideServiceEffect(Layout, Layout.make(home)),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    TestClock.withLive,
  )

layer(Platform.services)("claude integration stop", (it) => {
  it.effect("a worker sends its event verbatim as ExecutionEnd with the session's headers and writes no file", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      yield* stopAt(home, { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }, JSON.stringify(event))
      assert.isFalse(yield* fs.exists(path.join(home, "results")))
      assert.isFalse(yield* fs.exists(path.join(home, "reports")))
      const [request] = rpc(lines)
      assert.deepStrictEqual(request, {
        jsonrpc: "2.0",
        method: "ExecutionEnd",
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
      })
    }),
  )

  it.effect("a down vibestd: the report fails with the cause, nothing is written and no daemon is started", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* tempDirectory("s-")
      const stopping = yield* Effect.forkChild(
        stopAt(home, { VIBEST_AGENT: "session", VIBEST_SESSION_ID: "w1" }, JSON.stringify(event)).pipe(Effect.exit),
      )
      yield* untilVirtual(
        Effect.sync(() => stopping.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      const exit = yield* Fiber.join(stopping)
      assert.isTrue(Exit.isFailure(exit))
      assert.match(
        String(Exit.isFailure(exit) && exit.cause),
        /claude execution end of session w1 did not reach vibestd/,
      )
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
        assert.isUndefined(sending.pollUnsafe(), "the first try waits on the retry delay")
        yield* TestClock.adjust(HOOK_RETRY_DELAY)
        yield* Fiber.join(sending)
        assert.deepStrictEqual(
          rpc(retried).map((r) => r.method),
          ["ExecutionEnd"],
        )
        const dropped = yield* tempDirectory("d-")
        const seen: string[] = []
        yield* listen(path.join(dropped, "vibest.sock"), seen, (n) => (n === 1 ? "drop" : true))
        yield* stopAt(dropped, worker, JSON.stringify(event)).pipe(Effect.exit)
        assert.deepStrictEqual(
          rpc(seen).map((r) => r.method),
          ["ExecutionEnd"],
        )
        const hung = yield* tempDirectory("h-")
        const once: string[] = []
        yield* listen(path.join(hung, "vibest.sock"), once, () => "hang")
        yield* TestClock.withLive(stopAt(hung, worker, JSON.stringify(event)).pipe(Effect.exit))
        assert.deepStrictEqual(
          rpc(once).map((r) => r.method),
          ["ExecutionEnd"],
        )
      }),
  )

  it.effect(
    "without VIBEST_SESSION_ID nothing is sent; with it every event goes to vibestd verbatim, which decides what it is",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const home = yield* tempDirectory("s-")
        const lines: string[] = []
        yield* listen(path.join(home, "vibest.sock"), lines)
        for (const env of [{}, { VIBEST_AGENT: "general" }]) yield* stopAt(home, env, JSON.stringify(event))
        assert.deepStrictEqual(lines, [])
        const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }
        const raws = ["not json", JSON.stringify({ ...event, hook_event_name: "Stop" })]
        for (const raw of raws) yield* stopAt(home, worker, raw)
        assert.deepStrictEqual(
          rpc(lines).map((r) => (r.params as { event: string }).event),
          raws,
        )
      }),
  )

  it.effect("a prompt event goes to vibestd as Prompt with the session's harness", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const home = yield* tempDirectory("p-")
      const lines: string[] = []
      yield* listen(path.join(home, "vibest.sock"), lines)
      yield* promptAt(home, { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1" }, JSON.stringify(promptEvent))
      yield* promptAt(home, {}, JSON.stringify(promptEvent))
      assert.deepStrictEqual(
        rpc(lines).map((r) => [r.method, r.params]),
        [["Prompt", { sessionId: "w1", harness: "claude", event: JSON.stringify(promptEvent) }]],
      )
    }),
  )

  it.effect(
    "Cursor: session start is Session.Ready, its prompt and stop hooks send the raw event, conversation id included, with the process vibestd started it as",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path
        const home = yield* tempDirectory("c-")
        const lines: Array<string> = []
        yield* listen(path.join(home, "vibest.sock"), lines)
        const worker = { VIBEST_AGENT: "general", VIBEST_SESSION_ID: "w1", VIBEST_PROCESS: "7" }
        const invoke = (report: typeof integrationStop, event: unknown, env: Record<string, string> = worker) =>
          report("cursor", JSON.stringify(event)).pipe(
            Effect.provideServiceEffect(Layout, Layout.make(home)),
            Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          )
        yield* invoke(integrationReady, { hook_event_name: "sessionStart" })
        const prompt = { hook_event_name: "beforeSubmitPrompt", prompt: "go", conversation_id: "conv-1" }
        yield* invoke(integrationPrompt, prompt)
        yield* invoke(integrationStop, { hook_event_name: "afterAgentResponse", text: "done" })
        yield* invoke(integrationReady, { hook_event_name: "sessionStart" }, { VIBEST_AGENT: "general" })
        assert.deepStrictEqual(
          rpc(lines).map((r) => r.method),
          ["Session.Ready", "Prompt", "ExecutionEnd"],
        )
        assert.deepStrictEqual(rpc(lines)[0]?.params, { id: "w1" })
        for (const request of rpc(lines))
          assert.deepInclude(Object.fromEntries(request.headers as Array<[string, string]>), { "vibest-process": "7" })
        assert.deepStrictEqual(rpc(lines)[1]?.params, {
          sessionId: "w1",
          harness: "cursor",
          event: JSON.stringify(prompt),
        })
      }),
  )
})
