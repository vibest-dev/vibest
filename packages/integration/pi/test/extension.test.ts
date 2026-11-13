import net from "node:net"

import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { TuiAltScreen } from "@earendil-works/pi-tui"
import { assert, describe, it } from "@effect/vitest"
import {
  authed,
  FakeRuntime,
  makeRepository,
  savedSession,
  tempDirectory,
  CLAUDE,
  CURSOR,
  PI,
  testLayer,
  EXECUTIONS,
  type TestServices,
  until,
  untilVirtual,
  projectOf,
  entryPending,
} from "@vibest/cli/test/fakes"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { noticeEnvelope } from "@vibest/core/replies"
import * as Platform from "@vibest/platform-bun/bun"
import * as Server from "@vibest/server/server"
import { ConfigProvider, Effect, Exit, FileSystem, Layer, Path, type Ref, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vitest"

import { extension, services, skillsDir } from "../src/extension.ts"
import { Pi } from "../src/pi.ts"

const valuesStoredByRefSet = vi.hoisted(() => [] as Array<unknown>)
vi.mock("effect", async (importOriginal) => {
  const effect = await importOriginal<typeof import("effect")>()
  const set = effect.Function.dual(2, <A>(self: Ref.Ref<A>, value: A) =>
    effect.Effect.tap(effect.Ref.set(self, value), () =>
      effect.Effect.sync(() => void valuesStoredByRefSet.push(value)),
    ),
  )
  return { ...effect, Ref: { ...effect.Ref, set } }
})
vi.mock("@earendil-works/pi-coding-agent", () => ({
  UserMessageComponent: class {
    render() {
      return []
    }
  },
}))

const pulling = () => testLayer({ harnesses: [{ ...PI, inbox: "subscribe" as const }, CLAUDE, CURSOR] })

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(pulling()),
)

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>,
  timeout?: number,
) => it.effect(name, () => program.pipe(Effect.scoped, Effect.provide(served)), timeout)

const session = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const layout = yield* Layout
    const fs = yield* FileSystem.FileSystem
    const statuses: Array<string> = []
    const unused = Effect.die("unexpected tty operation")
    const file: FileSystem.File = {
      [FileSystem.FileTypeId]: FileSystem.FileTypeId,
      stat: unused,
      seek: () => unused,
      sync: unused,
      read: () => unused,
      readAlloc: () => unused,
      truncate: () => unused,
      writeAll: () => unused,
      write: (bytes: Uint8Array) =>
        Effect.sync(() => {
          statuses.push(new TextDecoder().decode(bytes))
          return bytes.length
        }),
    }
    const noTty = Layer.succeed(
      FileSystem.FileSystem,
      FileSystem.makeNoop({
        ...fs,
        open: (path, options) => (path === "/dev/tty" ? Effect.succeed(file) : fs.open(path, options)),
      }),
    )
    const handlers = new Map<string, Array<(e: unknown, ctx: unknown) => unknown>>()
    const messages: Array<{ message: unknown; options: unknown }> = []
    const renderers: Array<unknown> = []
    const fake: Pick<ExtensionAPI, "sendMessage" | "registerToolRenderer"> & {
      on: (event: string, handler: (e: unknown, ctx: unknown) => unknown) => () => void
    } = {
      on: (event, handler) => {
        handlers.set(event, [...(handlers.get(event) ?? []), handler])
        return () =>
          handlers.set(
            event,
            (handlers.get(event) ?? []).filter((h) => h !== handler),
          )
      },
      sendMessage: (message, options) => void messages.push({ message, options }),
      registerToolRenderer: (resolver) => void renderers.push(resolver),
    }
    const api = fake as unknown as ExtensionAPI
    const emit = (event: string, e: unknown = {}, ctx: unknown = {}) =>
      Effect.promise(async () => {
        const results = []
        const full = { sessionManager: { getSessionId: () => "pi-session" }, ...(ctx as object) }
        for (const h of handlers.get(event) ?? []) results.push(await h(e, full))
        return results
      })
    const config = ConfigProvider.layer(
      ConfigProvider.fromUnknown({ HOME: layout.home, VIBEST_HOME: layout.home, ...env }),
    )
    yield* Effect.promise(() =>
      Pi.runMain(api, extension.pipe(Layer.provide(Layer.merge(services, noTty)), Layer.provide(config))),
    )
    yield* Effect.addFinalizer(() => emit("session_shutdown"))
    return { handlers, messages, renderers, statuses, emit }
  })

const lease = () =>
  Object.getOwnPropertyDescriptor(UserMessageComponent.prototype, "vibestCompactUserMessagesLease")?.value
const tuiStart = {
  mode: "tui",
  hasUI: true,
  isIdle: () => true,
  sessionManager: { getSessionId: () => "s" },
  ui: { notify: () => {} },
}

const finishExecution = (
  s: { readonly emit: (event: string, e?: unknown, ctx?: unknown) => Effect.Effect<unknown> },
  execution: number,
) =>
  Effect.gen(function* () {
    yield* s.emit(
      "message_start",
      { message: { role: "custom", customType: "vibest", details: { execution } } },
      tuiStart,
    )
    yield* s.emit("agent_end", { messages: [] }, tuiStart)
    yield* s.emit("agent_settled", { aborted: false }, tuiStart)
  })

const executionOf = (message: unknown) => (message as { details: { execution: number } }).details.execution

const executionEnd = (mode: string, sessionId: string, notes: Array<string> = []) => ({
  mode,
  sessionManager: { getSessionId: () => sessionId },
  ui: { notify: (message: string) => void notes.push(message) },
})

const cli = Effect.gen(function* () {
  const root = yield* makeRepository
  return authed(yield* connect((yield* Layout).socket), cliHeaders(root))
})

const idleRow = <H extends "pi" | "claude">(harnessId: H) => ({
  agent: "general",
  name: "n",
  harnessId,
  provider: null,
  model: null,
  harnessSessionId: null,
  runtime: "herdr",
  address: { machine: "local", id: "test/p0" },
  status: "idle" as const,
  startedAt: 1,
  exitedAt: 1,
  executionState: "none" as const,
  executionPromptedAt: 0,
  createdAt: 1,
  lastActive: 1,
})

describe("pi-vibest", () => {
  it.effect(
    "Coordinator: while no vibestd answers it waits without starting one, then subscribes to the next vibestd",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const runtime = yield* FakeRuntime
        yield* runtime.addPane("w1:p8", "ws", "/")
        const row = idleRow("pi")
        yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...row }, yield* projectOf("r"))
        const coord = yield* db.startEntry(
          yield* projectOf("r"),
          "pi",
          false,
          {
            runtime: "herdr",
            address: { machine: "local", id: "w1:p8" },
          },
          { agent: "coordinator" },
        )
        yield* db.insertNoticeTo(coord.sessionId, "survives the gap")
        const notes: Array<string> = []
        const s = yield* session({
          VIBEST_AGENT: "coordinator",
          VIBEST_SESSION_ID: coord.sessionId,
          VIBEST_PROJECT_ID: coord.projectId,
          VIBEST_COMMAND: '["/nonexistent-vibest-fixture"]',
        })
        yield* s.emit(
          "session_start",
          { reason: "startup" },
          { ...tuiStart, ui: { notify: (message: string) => notes.push(message) } },
        )
        yield* TestClock.withLive(Effect.sleep("200 millis"))
        assert.isFalse(yield* fs.exists((yield* Path.Path).join(layout.home, "vibestd.log")))
        assert.deepStrictEqual(notes, [])
        yield* Layer.build(
          Server.layer.pipe(Layer.provide(Platform.socketServer(layout.socket)), Layer.provide(Project.layer)),
        )
        yield* TestClock.adjust("2 seconds")
        yield* until(
          Effect.sync(() => s.messages.length),
          (n) => n === 1,
        )
        assert.deepInclude(s.messages[0]?.message, {
          customType: "vibest",
          content: noticeEnvelope("survives the gap"),
          display: false,
        })
        assert.deepStrictEqual(notes, [])
      }).pipe(Effect.scoped, Effect.provide(pulling())),
    15_000,
  )

  it.effect(
    "Subagent: a ready report made while no vibestd answers reaches the next vibestd",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const layout = yield* Layout
        const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
        const project = yield* projectOf("r")
        yield* db.insertSession({ id, ...idleRow("pi") }, project)
        const s = yield* session({
          VIBEST_AGENT: "general",
          VIBEST_SESSION_ID: id,
          VIBEST_PROJECT_ID: project,
          VIBEST_COMMAND: '["vibest"]',
        })
        yield* s.emit("session_start", { reason: "startup" }, tuiStart)
        yield* TestClock.withLive(Effect.sleep("200 millis"))
        assert.isUndefined(yield* db.readyAt(id))
        yield* Layer.build(
          Server.layer.pipe(Layer.provide(Platform.socketServer(layout.socket)), Layer.provide(Project.layer)),
        )
        yield* untilVirtual(db.readyAt(id), (at) => at !== undefined)
      }).pipe(Effect.scoped, Effect.provide(pulling())),
    15_000,
  )

  it.effect(
    "Coordinator: a vibestd that stops ends the subscription on its side; the next vibestd's rows still arrive until the session shuts down, and none once vibestd sees the closed connection",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const layout = yield* Layout
        const runtime = yield* FakeRuntime
        yield* runtime.addPane("w1:p8", "ws", "/")
        const row = idleRow("claude")
        yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...row }, yield* projectOf("r"))
        const coord = yield* db.startEntry(
          yield* projectOf("r"),
          "pi",
          false,
          {
            runtime: "herdr",
            address: { machine: "local", id: "w1:p8" },
          },
          { agent: "coordinator" },
        )
        const vibestd = Server.layer.pipe(
          Layer.provide(Platform.socketServer(layout.socket)),
          Layer.provide(Project.layer),
        )
        const first = yield* Scope.make()
        yield* Layer.buildWithScope(vibestd, first)
        const notes: Array<string> = []
        const s = yield* session({
          VIBEST_AGENT: "coordinator",
          VIBEST_SESSION_ID: coord.sessionId,
          VIBEST_PROJECT_ID: coord.projectId,
          VIBEST_COMMAND: '["vibest"]',
        })
        yield* s.emit(
          "session_start",
          { reason: "startup" },
          { ...tuiStart, ui: { notify: (message: string) => notes.push(message) } },
        )
        const report = (message: string) => db.insertNoticeTo(coord.sessionId, message)
        const contents = Effect.sync(() => s.messages.map((m) => (m.message as { content: string }).content))
        yield* report("first")
        yield* until(contents, (c) => c.length === 1)
        yield* finishExecution(s, executionOf(s.messages[0]!.message))
        yield* Scope.close(first, Exit.void)
        yield* Layer.build(vibestd)
        yield* report("second")
        yield* until(contents, (c) => c.length === 2)
        assert.deepStrictEqual(yield* contents, [noticeEnvelope("first"), noticeEnvelope("second")])
        assert.deepStrictEqual(notes, [])
        const closeSeen = TestClock.withLive(Effect.sleep("500 millis"))
        yield* s.emit("session_shutdown")
        yield* closeSeen
        yield* report("after shutdown")
        yield* TestClock.withLive(Effect.sleep("3 seconds"))
        assert.deepStrictEqual(yield* contents, [noticeEnvelope("first"), noticeEnvelope("second")])
        assert.deepStrictEqual(
          (yield* entryPending(db, yield* projectOf("r"))).map((r) => r.message),
          [noticeEnvelope("after shutdown")],
        )
      }).pipe(Effect.scoped, Effect.provide(pulling())),
    30_000,
  )

  test(
    "Session TUI: grouped tools and the user-message lease, released at shutdown and taken again after a reload",
    Effect.gen(function* () {
      const render = UserMessageComponent.prototype.render
      const paint = Object.getOwnPropertyDescriptor(TuiAltScreen.prototype, "doRender")?.value
      for (const env of [
        {
          VIBEST_SESSION_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          VIBEST_COMMAND: '["vibest"]',
        },
      ]) {
        for (const _load of ["startup", "reload"]) {
          const s = yield* session(env)
          assert.strictEqual(s.renderers.length, 1)
          assert.isTrue(s.handlers.has("message_start") && s.handlers.has("tool_execution_end"))
          assert.deepStrictEqual(
            yield* s.emit("resources_discover", { type: "resources_discover", cwd: "/", reason: "startup" }),
            [{ skillPaths: [skillsDir] }],
          )
          yield* s.emit("session_start", { reason: "startup" }, { ...tuiStart, mode: "rpc" })
          assert.isUndefined(lease())
          yield* s.emit("session_start", { reason: "startup" }, tuiStart)
          const held = lease()
          assert.isDefined(held)
          assert.notStrictEqual(UserMessageComponent.prototype.render, render)
          yield* s.emit("session_start", { reason: "new" }, tuiStart)
          assert.strictEqual(lease().owners.size, 1)
          yield* s.emit("session_shutdown")
          assert.isUndefined(lease())
          assert.strictEqual(UserMessageComponent.prototype.render, render)
          assert.strictEqual(Object.getOwnPropertyDescriptor(TuiAltScreen.prototype, "doRender")?.value, paint)
        }
      }
    }),
  )

  test(
    "Plain Pi, without VIBEST_SESSION_ID: no TUI handlers, no renderer, no lease; only session_shutdown",
    Effect.gen(function* () {
      const render = UserMessageComponent.prototype.render
      for (const env of [{}, { VIBEST_AGENT: "general" }]) {
        const s = yield* session(env)
        assert.deepStrictEqual([...s.handlers.keys()], ["session_shutdown"])
        assert.deepStrictEqual(s.renderers, [])
        assert.deepStrictEqual(
          yield* s.emit("resources_discover", { type: "resources_discover", cwd: "/", reason: "startup" }),
          [],
        )
        assert.isFalse(
          [
            "message_update",
            "tool_execution_start",
            "tool_execution_end",
            "session_compact",
            "session_tree",
            "agent_start",
          ].some((e) => s.handlers.has(e)),
        )
        yield* s.emit("session_start", { reason: "startup" }, tuiStart)
        assert.isUndefined(lease())
        assert.strictEqual(UserMessageComponent.prototype.render, render)
      }
    }),
  )

  test(
    "Coordinator: no MCP server, its tool rules allow vibest, and inbox rows arrive as hidden custom messages, never through agent.prompt",
    Effect.gen(function* () {
      const runtime = yield* FakeRuntime
      const db = yield* Db
      yield* runtime.addPane("w1:p7", "ws", "/")
      const row = idleRow("pi")
      yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...row }, yield* projectOf("r"))
      yield* db.insertSession({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...row }, yield* projectOf("r"))
      const coord = yield* db.startEntry(
        yield* projectOf("r"),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p7" },
        },
        { agent: "coordinator" },
      )
      yield* db.insertNoticeTo(coord.sessionId, "<agent-result>one</agent-result>")

      const s = yield* session({
        VIBEST_AGENT: "coordinator",
        VIBEST_SESSION_ID: coord.sessionId,
        VIBEST_PROJECT_ID: coord.projectId,
        VIBEST_COMMAND: '["/usr/bin/bun","/src/main.ts"]',
      })
      assert.deepStrictEqual(
        yield* s.emit("tool_call", { toolName: "bash", input: { command: "git diff | head" } }, { cwd: "/" }),
        [undefined],
      )
      const bash = (command: string) => s.emit("tool_call", { toolName: "bash", input: { command } }, { cwd: "/" })
      assert.deepStrictEqual(yield* bash("/usr/bin/bun /src/main.ts run pi 'Fix it.\nKeep $HOME as text.'"), [
        undefined,
      ])
      assert.deepStrictEqual(yield* bash("vibest send abcd1234-abcd-4abc-8abc-abcd1234abcd 'more'"), [undefined])
      assert.deepStrictEqual(yield* bash("/usr/bin/bun /src/main.ts daemon"), [undefined])
      assert.deepStrictEqual(yield* bash("jq . a.json > /tmp/b"), [undefined])
      assert.deepStrictEqual(yield* bash("VIBEST_SESSION_ID= vibest rm abcd1234-abcd-4abc-8abc-abcd1234abcd"), [
        {
          block: true,
          reason: "vibest runs with the agent's own VIBEST_SESSION_ID; a command that changes or clears it is refused.",
        },
      ])
      assert.deepStrictEqual(yield* s.emit("tool_call", { toolName: "write", input: { path: "a" } }, { cwd: "/" }), [
        {
          block: true,
          reason:
            "The coordinator edits files only in the project folder (VIBEST_PROJECT_DIR); hand other changes to a session.",
        },
      ])
      yield* s.emit("session_start", { reason: "startup" }, { mode: "rpc" })
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      assert.deepStrictEqual(s.messages, [])
      assert.strictEqual((yield* entryPending(db, yield* projectOf("r"))).length, 1)
      yield* s.emit("session_start", { reason: "startup" }, tuiStart)
      yield* until(
        Effect.sync(() => s.messages.length),
        (n) => n === 1,
      )
      yield* finishExecution(s, executionOf(s.messages[0]!.message))
      yield* db.insertNoticeTo(coord.sessionId, "<agent-message>two</agent-message>")
      yield* until(
        Effect.sync(() => s.messages.length),
        (n) => n === 2,
      )
      assert.deepStrictEqual(
        s.messages.map((m) => [
          (m.message as { content: string }).content,
          (m.message as { display: boolean }).display,
          m.options,
        ]),
        [
          [noticeEnvelope("<agent-result>one</agent-result>"), false, { triggerTurn: true }],
          [noticeEnvelope("<agent-message>two</agent-message>"), false, { triggerTurn: true }],
        ],
      )
      assert.notStrictEqual(executionOf(s.messages[0]!.message), executionOf(s.messages[1]!.message))
      assert.deepStrictEqual(yield* entryPending(db, yield* projectOf("r")), [])
    }),
  )

  test(
    "an input event records what the user typed, in any session; an extension delivery does not",
    Effect.gen(function* () {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const row = idleRow("pi")
      yield* db.insertSession({ id: "abcd1234-abcd-4abc-8abc-abcd1234abcd", ...row }, yield* projectOf("r"))
      const coord = yield* db.startEntry(
        yield* projectOf("r"),
        "pi",
        false,
        {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p7" },
        },
        { agent: "coordinator" },
      )
      const messages = () =>
        sql<{
          input: string
          inbox: number | null
        }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = 'abcd1234-abcd-4abc-8abc-abcd1234abcd' ORDER BY id`.pipe(
          Effect.orDie,
        )
      const s = yield* session({
        VIBEST_AGENT: "general",
        VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
        VIBEST_COMMAND: '["vibest"]',
      })
      yield* s.emit("input", { type: "input", text: "hello from the pane", source: "interactive" })
      assert.deepStrictEqual(yield* messages(), [{ input: "hello from the pane", inbox: null }])
      yield* s.emit("input", { type: "input", text: "vibest handed this over", source: "extension" })
      yield* s.emit("input", { type: "input", text: "again", source: "interactive" })
      assert.deepStrictEqual(yield* messages(), [{ input: "hello from the pane", inbox: null }])
      const coordinator = yield* session({
        VIBEST_AGENT: "coordinator",
        VIBEST_SESSION_ID: coord.sessionId,
        VIBEST_PROJECT_ID: coord.projectId,
        VIBEST_COMMAND: '["vibest"]',
      })
      yield* coordinator.emit("input", { type: "input", text: "the normal conversation", source: "interactive" })
      assert.deepStrictEqual(
        yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM ${sql.literal(EXECUTIONS)} m WHERE session_id = ${coord.sessionId}`.pipe(
          Effect.orDie,
        ),
        [{ n: 1 }],
      )
    }),
  )

  test(
    "Coordinator: a TUI startup execution reports its session id once; /new, /resume and /fork report before the next execution",
    Effect.gen(function* () {
      const db = yield* Db
      const c = yield* cli
      const launched = yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "pi",
        fresh: false,
        terminal: "test/p1",
      })
      assert.isNull(launched.harnessSessionId)
      const saved = savedSession(launched.sessionId)
      const env = {
        VIBEST_AGENT: "coordinator",
        VIBEST_SESSION_ID: launched.sessionId,
        VIBEST_PROJECT_ID: launched.projectId,
        VIBEST_LAUNCH_PID: String(process.pid),
        VIBEST_COMMAND: '["vibest"]',
      }
      const s = yield* session(env)
      yield* s.emit("agent_end", { messages: [] }, executionEnd("rpc", "child"))
      yield* s.emit("agent_end", { messages: [] }, executionEnd("print", "child"))
      yield* s.emit("session_start", { type: "session_start", reason: "startup" }, executionEnd("tui", "s-startup"))
      yield* s.emit("session_start", { type: "session_start", reason: "reload" }, executionEnd("tui", "s-reload"))
      yield* s.emit("session_start", { type: "session_start", reason: "new" }, executionEnd("rpc", "s-rpc"))
      yield* s.emit("session_start", { type: "session_start", reason: "new" }, executionEnd("print", "s-print"))
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      assert.isNull(yield* saved)
      assert.isFalse(
        ["child", "s-startup", "s-reload", "s-rpc", "s-print"].some((id) => valuesStoredByRefSet.includes(id)),
      )
      const s1 = `s1:${launched.sessionId}`
      yield* s.emit("agent_end", { messages: [] }, executionEnd("tui", s1))
      yield* until(
        Effect.sync(() => valuesStoredByRefSet.includes(s1)),
        Boolean,
      )
      assert.strictEqual(yield* saved, s1)
      yield* db.noteConversation(launched.sessionId, "other")
      yield* s.emit("agent_end", { messages: [] }, executionEnd("tui", s1))
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      assert.strictEqual(yield* saved, "other")
      yield* s.emit("session_start", { type: "session_start", reason: "new" }, executionEnd("tui", "s-new"))
      yield* until(saved, (id) => id === "s-new")
      yield* s.emit("session_start", { type: "session_start", reason: "resume" }, executionEnd("tui", "s-resume"))
      yield* until(saved, (id) => id === "s-resume")
      yield* s.emit("session_start", { type: "session_start", reason: "fork" }, executionEnd("tui", "s-fork"))
      yield* until(saved, (id) => id === "s-fork")
      yield* until(
        Effect.sync(() => valuesStoredByRefSet.includes("s-fork")),
        Boolean,
      )
      assert.strictEqual(
        (yield* c["Project.EntrySession"]({ agent: "coordinator", harness: "pi", fresh: false, terminal: "test/p1" }))
          .harnessSessionId,
        "s-fork",
      )
      yield* db.noteConversation(launched.sessionId, "kept")
      yield* s.emit("agent_end", { messages: [] }, executionEnd("tui", "s-fork"))
      assert.strictEqual(yield* saved, "kept")
      const renewed = yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "pi",
        fresh: true,
        terminal: "test/p1",
      })
      assert.notStrictEqual(renewed.sessionId, launched.sessionId)
      assert.isNull(renewed.harnessSessionId)
      assert.isNull(yield* saved)
    }),
  )

  test(
    "Coordinator: a report vibestd applies after a newer one, even past its timeout, does not overwrite it",
    Effect.gen(function* () {
      const layout = yield* Layout
      const path = yield* Path.Path
      const c = yield* cli
      const launched = yield* c["Project.EntrySession"]({
        agent: "coordinator",
        harness: "pi",
        fresh: false,
        terminal: "test/p1",
      })
      const saved = savedSession(launched.sessionId)
      const home = yield* tempDirectory("pi-vibest-slow-")
      const first = {
        held: [] as Array<string | Buffer>,
        released: false,
        answered: false,
        upstream: undefined as net.Socket | undefined,
      }
      let connections = 0
      const proxy = net.createServer((socket) => {
        const isFirst = connections++ === 0
        const upstream = net.connect(layout.socket)
        if (isFirst) first.upstream = upstream
        upstream.on("data", (chunk) => {
          if (isFirst) first.answered = true
          if (!socket.destroyed) socket.write(chunk)
        })
        socket.on("error", () => {})
        socket.on("data", (chunk) => (isFirst && !first.released ? first.held.push(chunk) : upstream.write(chunk)))
      })
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => void proxy.listen(path.join(home, "vibest.sock"), () => resume(Effect.void))),
        () => Effect.sync(() => proxy.close()),
      )
      const notes: Array<string> = []
      const s = yield* session({
        VIBEST_AGENT: "coordinator",
        VIBEST_SESSION_ID: launched.sessionId,
        VIBEST_PROJECT_ID: launched.projectId,
        VIBEST_LAUNCH_PID: String(process.pid),
        VIBEST_COMMAND: '["vibest"]',
        VIBEST_HOME: home,
      })
      yield* s.emit("agent_end", { messages: [] }, executionEnd("tui", "s1", notes))
      yield* until(
        Effect.sync(() => first.held.length > 0),
        Boolean,
      )
      yield* s.emit("agent_end", { messages: [] }, executionEnd("tui", "s2", notes))
      yield* until(saved, (id) => id === "s2")
      yield* until(
        Effect.sync(() => notes.length === 1),
        Boolean,
      )
      assert.match(notes[0]!, /^vibest: the entry session's conversation may not have been saved/)
      first.released = true
      for (const chunk of first.held) first.upstream!.write(chunk)
      yield* until(
        Effect.sync(() => first.answered),
        Boolean,
      )
      assert.strictEqual(yield* saved, "s1")
    }),
    15000,
  )

  test(
    "Coordinator: the execution never waits for the report; vibestd hanging or gone ends in a warning, and the next execution tries again",
    Effect.gen(function* () {
      const path = yield* Path.Path
      const hanging = yield* tempDirectory("pi-vibest-hang-")
      const server = net.createServer(() => {})
      yield* Effect.acquireRelease(
        Effect.callback<void>(
          (resume) => void server.listen(path.join(hanging, "vibest.sock"), () => resume(Effect.void)),
        ),
        () => Effect.sync(() => server.close()),
      )
      const gone = yield* tempDirectory("pi-vibest-gone-")
      for (const home of [hanging, gone]) {
        const s = yield* session({
          VIBEST_AGENT: "coordinator",
          VIBEST_SESSION_ID: "L",
          VIBEST_LAUNCH_PID: String(process.pid),
          VIBEST_COMMAND: '["false"]',
          VIBEST_HOME: home,
        })
        const notes: Array<string> = []
        for (const execution of [1, 2]) {
          yield* s.emit("agent_end", { messages: [] }, executionEnd("tui", "s1", notes))
          assert.strictEqual(notes.length, execution - 1, "the execution ended before its reply did")
          yield* until(
            Effect.sync(() => notes.length === execution),
            Boolean,
          )
        }
        assert.match(notes[0]!, /^vibest: the entry session's conversation may not have been saved/)
      }
    }),
    30000,
  )
})
