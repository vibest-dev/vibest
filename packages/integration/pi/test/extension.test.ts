import net from "node:net"

import { type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent"
import { TuiAltScreen } from "@earendil-works/pi-tui"
import { assert, describe, it } from "@effect/vitest"
import * as Platform from "@vibest/cli/platform/bun"
import {
  authed,
  FakeRuntime,
  makeRepository,
  savedSession,
  tempDirectory,
  testLayer,
  TURNS,
  type TestServices,
  until,
  untilVirtual,
  projectOf,
} from "@vibest/cli/test/fakes"
import { cliHeaders, connect } from "@vibest/client/client"
import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
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

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
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
const tuiStart = { mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "s" }, ui: { notify: () => {} } }

const turnEnd = (mode: string, sessionId: string, notes: Array<string> = []) => ({
  mode,
  sessionManager: { getSessionId: () => sessionId },
  ui: { notify: (message: string) => void notes.push(message) },
})

const cli = Effect.gen(function* () {
  const root = yield* makeRepository
  return authed(yield* connect((yield* Layout).socket), cliHeaders(root))
})

describe("pi-vibest", () => {
  test(
    "Pi owns all terminal reports; vibest never writes a competing status",
    Effect.gen(function* () {
      for (const agent of ["general", "coordinator"]) {
        const s = yield* session({ VIBEST_AGENT: agent, VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd" })
        for (const mode of ["tui", "rpc", "print", "json"]) {
          const ctx = { ...tuiStart, mode, isIdle: () => true }
          yield* s.emit("session_start", { reason: "startup" }, ctx)
          yield* s.emit("input", { source: "interactive", text: "hello" }, ctx)
          yield* s.emit("agent_start", {}, ctx)
          for (const kind of ["confirm", "select", "input", "editor", "custom"]) {
            yield* s.emit("ui_prompt_start", { reason: "ui_prompt", kind }, ctx)
            yield* s.emit("ui_prompt_end", { reason: "ui_prompt", kind }, ctx)
          }
          yield* s.emit("agent_end", { messages: [] }, ctx)
          yield* s.emit("agent_settled", { aborted: false }, ctx)
          yield* s.emit("agent_settled", { aborted: true }, ctx)
        }
        assert.deepStrictEqual(s.statuses, [])
      }
    }),
  )

  it.effect(
    "Coordinator: while no vibestd answers it waits without starting one, then subscribes to the next vibestd",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const layout = yield* Layout
        const fs = yield* FileSystem.FileSystem
        const runtime = yield* FakeRuntime
        yield* runtime.addPane("w1:p8", "ws", "/")
        const row = {
          agent: "general",
          name: "n",
          harnessId: "pi" as const,
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: "herdr",
          address: { machine: "local", id: "test/p0" },
          status: "idle" as const,
          startedAt: 1,
          exitedAt: 1,
          turnState: "none" as const,
          turnPromptedAt: 0,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        }
        yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...row }, yield* projectOf("r"))
        const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p8" },
        })
        yield* (yield* Inbox).enqueue({
          sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          message: "survives the gap",
        })
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
        assert.deepStrictEqual(s.messages[0]?.message, {
          customType: "vibest",
          content: "survives the gap",
          display: false,
        })
        assert.deepStrictEqual(notes, [])
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
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
        yield* db.insertSession(
          {
            id,
            agent: "general",
            name: "n",
            harnessId: "pi",
            provider: null,
            model: null,
            harnessSessionId: null,
            runtime: "herdr",
            address: { machine: "local", id: "test/p0" },
            status: "idle",
            startedAt: 1,
            exitedAt: 1,
            turnState: "none",
            turnPromptedAt: 0,
            metadata: {},
            createdAt: 1,
            lastActive: 1,
          },
          project,
        )
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
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    15_000,
  )

  it.effect(
    "Coordinator: a vibestd that stops ends the subscription on its side; the next vibestd's rows still arrive until the session shuts down, and none once vibestd sees the closed connection",
    () =>
      Effect.gen(function* () {
        const db = yield* Db
        const inbox = yield* Inbox
        const layout = yield* Layout
        const runtime = yield* FakeRuntime
        yield* runtime.addPane("w1:p8", "ws", "/")
        const row = {
          agent: "general",
          name: "n",
          harnessId: "claude" as const,
          provider: null,
          model: null,
          harnessSessionId: null,
          runtime: "herdr",
          address: { machine: "local", id: "test/p0" },
          status: "idle" as const,
          startedAt: 1,
          exitedAt: 1,
          turnState: "none" as const,
          turnPromptedAt: 0,
          metadata: {},
          createdAt: 1,
          lastActive: 1,
        }
        yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...row }, yield* projectOf("r"))
        const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
          runtime: "herdr",
          address: { machine: "local", id: "w1:p8" },
        })
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
        const report = (message: string) =>
          inbox.enqueue({ sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", message })
        const contents = Effect.sync(() => s.messages.map((m) => (m.message as { content: string }).content))
        yield* report("first")
        yield* until(contents, (c) => c.length === 1)
        yield* Scope.close(first, Exit.void)
        yield* Layer.build(vibestd)
        yield* report("second")
        yield* until(contents, (c) => c.length === 2)
        assert.deepStrictEqual(yield* contents, ["first", "second"])
        assert.deepStrictEqual(notes, [])
        const closeSeen = TestClock.withLive(Effect.sleep("500 millis"))
        yield* s.emit("session_shutdown")
        yield* closeSeen
        yield* report("after shutdown")
        yield* TestClock.withLive(Effect.sleep("3 seconds"))
        assert.deepStrictEqual(yield* contents, ["first", "second"])
        assert.deepStrictEqual(
          (yield* db.coordinatorPending(yield* projectOf("r"))).map((r) => r.message),
          ["after shutdown"],
        )
      }).pipe(Effect.scoped, Effect.provide(testLayer())),
    30_000,
  )

  test(
    "Coordinator TUI, with or without VIBEST_SESSION_ID: grouped tools and the user-message lease, released at shutdown and taken again after a reload",
    Effect.gen(function* () {
      const render = UserMessageComponent.prototype.render
      const paint = Object.getOwnPropertyDescriptor(TuiAltScreen.prototype, "doRender")?.value
      for (const env of [
        {
          VIBEST_AGENT: "coordinator",
          VIBEST_SESSION_ID: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          VIBEST_COMMAND: '["vibest"]',
        },
        { VIBEST_AGENT: "coordinator" },
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
    "Other agents and plain Pi: no TUI handlers, no renderer, no lease; without VIBEST_AGENT only session_shutdown",
    Effect.gen(function* () {
      const render = UserMessageComponent.prototype.render
      for (const env of [
        {},
        {
          VIBEST_AGENT: "general",
          VIBEST_SESSION_ID: "abcd1234-abcd-4abc-8abc-abcd1234abcd",
          VIBEST_COMMAND: '["vibest"]',
        },
        { VIBEST_AGENT: "general" },
      ]) {
        const s = yield* session(env)
        if (env.VIBEST_AGENT === undefined) assert.deepStrictEqual([...s.handlers.keys()], ["session_shutdown"])
        assert.deepStrictEqual(s.renderers, [])
        assert.deepStrictEqual(
          yield* s.emit("resources_discover", { type: "resources_discover", cwd: "/", reason: "startup" }),
          [],
        )
        assert.isFalse(
          [
            "message_start",
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
      const inbox = yield* Inbox
      const db = yield* Db
      yield* runtime.addPane("w1:p7", "ws", "/")
      const row = {
        agent: "general",
        name: "n",
        harnessId: "pi" as const,
        provider: null,
        model: null,
        harnessSessionId: null,
        runtime: "herdr",
        address: { machine: "local", id: "test/p0" },
        status: "idle" as const,
        startedAt: 1,
        exitedAt: 1,
        turnState: "none" as const,
        turnPromptedAt: 0,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", ...row }, yield* projectOf("r"))
      yield* db.insertSession({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", ...row }, yield* projectOf("r"))
      const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p7" },
      })
      yield* inbox.enqueue({
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        message: "<agent-result>one</agent-result>",
      })

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
          reason:
            "vibest runs with the agent's own VIBEST_SESSION_ID and VIBEST_AGENT; a command that changes or clears them is refused.",
        },
      ])
      assert.deepStrictEqual(yield* s.emit("tool_call", { toolName: "write", input: { path: "a" } }, { cwd: "/" }), [
        {
          block: true,
          reason:
            "The coordinator edits files only in the project folder (VIBEST_PROJECT_DIR); hand other changes to a session.",
        },
      ])
      const start = { systemPromptOptions: { sections: { ponytail: "be lazy" } as Record<string, string> } }
      yield* s.emit("before_agent_start", start)
      assert.deepStrictEqual(start.systemPromptOptions.sections, {})
      yield* s.emit("session_start", { reason: "startup" }, { mode: "rpc" })
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      assert.deepStrictEqual(s.messages, [])
      assert.strictEqual((yield* db.coordinatorPending(yield* projectOf("r"))).length, 1)
      yield* s.emit("session_start", { reason: "startup" }, { mode: "tui" })
      yield* until(
        Effect.sync(() => s.messages.length),
        (n) => n === 1,
      )
      yield* inbox.enqueue({
        sessionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        message: "<agent-message>two</agent-message>",
      })
      yield* until(
        Effect.sync(() => s.messages.length),
        (n) => n === 2,
      )
      assert.deepStrictEqual(s.messages, [
        {
          message: { customType: "vibest", content: "<agent-result>one</agent-result>", display: false },
          options: { triggerTurn: true, deliverAs: "followUp" },
        },
        {
          message: { customType: "vibest", content: "<agent-message>two</agent-message>", display: false },
          options: { triggerTurn: true, deliverAs: "followUp" },
        },
      ])
      assert.deepStrictEqual(yield* db.coordinatorPending(yield* projectOf("r")), [])
    }),
  )

  test(
    "a subagent input event records what the user typed; an extension delivery and the coordinator do not",
    Effect.gen(function* () {
      const db = yield* Db
      const sql = yield* SqlClient.SqlClient
      const row = {
        agent: "general",
        name: "n",
        harnessId: "pi" as const,
        provider: null,
        model: null,
        harnessSessionId: null,
        runtime: "herdr",
        address: { machine: "local", id: "test/p0" },
        status: "idle" as const,
        startedAt: 1,
        exitedAt: 1,
        turnState: "none" as const,
        turnPromptedAt: 0,
        metadata: {},
        createdAt: 1,
        lastActive: 1,
      }
      yield* db.insertSession({ id: "abcd1234-abcd-4abc-8abc-abcd1234abcd", ...row }, yield* projectOf("r"))
      const coord = yield* db.coordinatorLaunch(yield* projectOf("r"), "pi", false, {
        runtime: "herdr",
        address: { machine: "local", id: "w1:p7" },
      })
      const messages = () =>
        sql<{
          input: string
          inbox: number | null
        }>`SELECT input, inbox_id AS inbox FROM ${sql.literal(TURNS)} m WHERE session_id = 'abcd1234-abcd-4abc-8abc-abcd1234abcd' ORDER BY id`.pipe(
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
      assert.isFalse(coordinator.handlers.has("input"))
      yield* coordinator.emit("input", { type: "input", text: "the normal conversation", source: "interactive" })
      assert.deepStrictEqual(
        yield* sql<{
          n: number
        }>`SELECT count(*) AS n FROM ${sql.literal(TURNS)} m WHERE session_id = ${coord.sessionId}`.pipe(Effect.orDie),
        [{ n: 0 }],
      )
    }),
  )

  test(
    "VIBEST_AGENT without VIBEST_SESSION_ID: the guard still applies, only the result file is left out",
    Effect.gen(function* () {
      const layout = yield* Layout
      const s = yield* session({ VIBEST_AGENT: "general", VIBEST_COMMAND: '["vibest"]' })
      assert.deepStrictEqual([...s.handlers.keys()].sort(), ["session_shutdown", "tool_call"])
      const call = (toolName: string, input: object) => s.emit("tool_call", { toolName, input }, { cwd: "/" })
      assert.deepStrictEqual(yield* call("read", { path: `${layout.projects}/k/memories/a.md` }), [
        {
          block: true,
          reason:
            "The projects directory is off limits to sessions, except this project's folder (VIBEST_PROJECT_DIR).",
        },
      ])
    }),
  )

  test(
    "Coordinator: a TUI startup turn reports its session id once; /new, /resume and /fork report before the next turn",
    Effect.gen(function* () {
      const db = yield* Db
      const c = yield* cli
      const launched = yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })
      assert.isNull(launched.harnessSessionId)
      const saved = savedSession(launched.sessionId)
      const env = {
        VIBEST_AGENT: "coordinator",
        VIBEST_SESSION_ID: launched.sessionId,
        VIBEST_LAUNCH_PID: String(process.pid),
        VIBEST_COMMAND: '["vibest"]',
      }
      const s = yield* session(env)
      yield* s.emit("agent_end", { messages: [] }, turnEnd("rpc", "child"))
      yield* s.emit("agent_end", { messages: [] }, turnEnd("print", "child"))
      yield* s.emit("session_start", { type: "session_start", reason: "startup" }, turnEnd("tui", "s-startup"))
      yield* s.emit("session_start", { type: "session_start", reason: "reload" }, turnEnd("tui", "s-reload"))
      yield* s.emit("session_start", { type: "session_start", reason: "new" }, turnEnd("rpc", "s-rpc"))
      yield* s.emit("session_start", { type: "session_start", reason: "new" }, turnEnd("print", "s-print"))
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      assert.isNull(yield* saved)
      assert.isFalse(
        ["child", "s-startup", "s-reload", "s-rpc", "s-print"].some((id) => valuesStoredByRefSet.includes(id)),
      )
      const s1 = `s1:${launched.sessionId}`
      yield* s.emit("agent_end", { messages: [] }, turnEnd("tui", s1))
      yield* until(
        Effect.sync(() => valuesStoredByRefSet.includes(s1)),
        Boolean,
      )
      assert.strictEqual(yield* saved, s1)
      yield* db.reportCoordinatorSession(launched.sessionId, "pi", "other")
      yield* s.emit("agent_end", { messages: [] }, turnEnd("tui", s1))
      yield* TestClock.withLive(Effect.sleep("300 millis"))
      assert.strictEqual(yield* saved, "other")
      yield* s.emit("session_start", { type: "session_start", reason: "new" }, turnEnd("tui", "s-new"))
      yield* until(saved, (id) => id === "s-new")
      yield* s.emit("session_start", { type: "session_start", reason: "resume" }, turnEnd("tui", "s-resume"))
      yield* until(saved, (id) => id === "s-resume")
      yield* s.emit("session_start", { type: "session_start", reason: "fork" }, turnEnd("tui", "s-fork"))
      yield* until(saved, (id) => id === "s-fork")
      yield* until(
        Effect.sync(() => valuesStoredByRefSet.includes("s-fork")),
        Boolean,
      )
      assert.strictEqual(
        (yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })).harnessSessionId,
        "s-fork",
      )
      yield* db.reportCoordinatorSession(launched.sessionId, "pi", "kept")
      yield* s.emit("agent_end", { messages: [] }, turnEnd("tui", "s-fork"))
      assert.strictEqual(yield* saved, "kept")
      const renewed = yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: true, terminal: "test/p1" })
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
      const launched = yield* c["Project.CoordinatorSession"]({ harness: "pi", fresh: false, terminal: "test/p1" })
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
        VIBEST_LAUNCH_PID: String(process.pid),
        VIBEST_COMMAND: '["vibest"]',
        VIBEST_HOME: home,
      })
      yield* s.emit("agent_end", { messages: [] }, turnEnd("tui", "s1", notes))
      yield* until(
        Effect.sync(() => first.held.length > 0),
        Boolean,
      )
      yield* s.emit("agent_end", { messages: [] }, turnEnd("tui", "s2", notes))
      yield* until(saved, (id) => id === "s2")
      yield* until(
        Effect.sync(() => notes.length === 1),
        Boolean,
      )
      assert.match(notes[0]!, /^vibest: the coordinator's conversation may not have been saved/)
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
    "Coordinator: the turn never waits for the report; vibestd hanging or gone ends in a warning, and the next turn tries again",
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
        for (const turn of [1, 2]) {
          yield* s.emit("agent_end", { messages: [] }, turnEnd("tui", "s1", notes))
          assert.strictEqual(notes.length, turn - 1, "the turn ended before its report did")
          yield* until(
            Effect.sync(() => notes.length === turn),
            Boolean,
          )
        }
        assert.match(notes[0]!, /^vibest: the coordinator's conversation may not have been saved/)
      }
    }),
    30000,
  )
})
