import http from "node:http"

import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { pidOf } from "@vibest/core/database/db-rows"
import { Inbox } from "@vibest/core/inbox"
import { Project } from "@vibest/core/project"
import { Session } from "@vibest/core/session"
import { sessionHeaders, type SessionIdentity } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import * as Server from "@vibest/server/server"
import {
  VERSION,
  CLAUDE,
  CURSOR,
  FakeRuntime,
  PI,
  makeRepository,
  testLayer,
  type TestServices,
  until,
  projectOf,
} from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Layer, Predicate, type Schema, type Scope } from "effect"

const AGY = {
  ...CURSOR,
  id: "agy",
  binary: "agy",
  guardCall: (event: Schema.JsonObject) => {
    const toolCall = Predicate.isObject(event.toolCall) ? (event.toolCall as Schema.JsonObject) : undefined

    if (!toolCall || toolCall.name !== "run_command") return undefined
    const args = Predicate.isObject(toolCall.args) ? (toolCall.args as Schema.JsonObject) : {}

    return {
      tool_name: "Bash",
      tool_input: { command: Predicate.isString(args.CommandLine) ? args.CommandLine : "" },
      ...(Predicate.isString(event.cwd) && { cwd: event.cwd }),
    }
  },
  guardAnswer: (reason: string | undefined) => (reason ? { decision: "deny", reason } : { decision: "allow" }),
}

const servedHttp = () =>
  Server.layer.pipe(
    Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
    Layer.provideMerge(Project.layer),
    Layer.provideMerge(testLayer({ harnesses: [{ ...CLAUDE, delivery: "pull" }, PI, CURSOR, AGY] })),
  )

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project.Service | Scope.Scope>) =>
  it.live(name, () => program.pipe(Effect.scoped, Effect.provide(servedHttp())))

const postUnix = (socketPath: string, path: string, headers: Record<string, string>, body: string) =>
  Effect.promise(
    () =>
      new Promise<{ readonly status: number; readonly body: unknown }>((resolve, reject) => {
        const req = http.request(
          {
            socketPath,
            method: "POST",
            path,
            headers: {
              "content-type": path === "/api/hook/ready" ? "application/json" : "text/plain",
              ...headers,
            },
          },
          (res) => {
            let text = ""
            res.setEncoding("utf8")
            res.on("data", (chunk: string) => {
              text += chunk
            })
            res.on("end", () => {
              let parsed: unknown = undefined

              if (text !== "") {
                try {
                  parsed = JSON.parse(text)
                } catch {
                  parsed = text
                }
              }

              resolve({ status: res.statusCode ?? 0, body: parsed })
            })
          },
        )

        req.on("error", reject)
        req.write(body)
        req.end()
      }),
  )

const project = Effect.gen(function* () {
  const db = yield* Db.Service
  const herdr = yield* FakeRuntime
  const layout = yield* Layout
  const repo = yield* makeRepository
  const key = yield* projectOf(repo)

  const entry = yield* db.session.startRoot(
    key,
    "claude",
    false,
    {
      runtime: RUNTIME,
      target: { id: "test/coord" },
    },
    { agent: "coordinator" },
  )

  yield* herdr.seedAgent("test/coord")
  const sessions = yield* Session.Service

  const { id: worker } = yield* sessions.spawn({
    agent: "general",
    machine: { id: "local" },
    root: repo,
    parentSessionId: "creator",
    projectId: key,
    name: "Fix the guard",
    prompt: "do it",
    runtime: "herdr",
    harness: "claude",
  })

  const projectId = entry.projectId

  const call = (path: string, who: Partial<SessionIdentity> & { sessionId: string }, body = "{}") =>
    postUnix(layout.socket, path, sessionHeaders({ projectId: String(projectId), harness: "claude", ...who }), body)

  return {
    db,
    herdr,
    entryId: entry.sessionId,
    worker,
    projectId,
    repo,
    key,
    sessions,
    call,
    inbox: yield* Inbox.Service,
  }
})

describe("vibestd's unified HTTP API", () => {
  test(
    "a late Ready from the process a restart replaced changes nothing; the restarted harness's Ready is taken",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      yield* until(db.session.getSession(worker), (s) => (s ? (s.process?.placedAt ?? null) : undefined) != null)
      const first = (yield* db.session.currentProcessId(worker))!

      const ready = (process: number, pid: number, pluginVersion = VERSION) =>
        call("/api/hook/ready", { sessionId: worker, process: String(process), pluginVersion }, JSON.stringify({ pid }))

      assert.deepStrictEqual((yield* ready(first, 111)).body, { process: first })
      yield* db.session.restartProcess(worker)
      const second = (yield* db.session.currentProcessId(worker))!
      assert.notStrictEqual(second, first)
      const late = yield* ready(first, 111)
      assert.strictEqual(late.status, 200)
      assert.deepStrictEqual(late.body, {})
      assert.isUndefined(yield* db.session.readyAt(worker))
      assert.isUndefined(pidOf((yield* db.session.getSession(worker))!))
      assert.deepStrictEqual((yield* ready(first, 222, "0.0.2-next")).body, { process: second })
      assert.isNumber(yield* db.session.readyAt(worker))
      assert.deepInclude((yield* db.session.getSession(worker))!.process, {
        pid: 222,
        integration: { version: "0.0.2-next", protocol: PROTOCOL },
      })
    }),
  )

  test(
    "Ready takes {} and a numeric pid; a malformed body or a wrong pid type is 400 InvalidRequestError and changes nothing",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      yield* until(db.session.getSession(worker), (s) => (s ? (s.process?.placedAt ?? null) : undefined) != null)
      const process = (yield* db.session.currentProcessId(worker))!
      const ready = (body: string) => call("/api/hook/ready", { sessionId: worker, process: String(process) }, body)
      const pid = () => Effect.map(db.session.getSession(worker), (session) => pidOf(session!))
      const readyAt = yield* db.session.readyAt(worker)
      const reportedPid = yield* pid()

      const badJson = yield* ready("{")
      assert.strictEqual(badJson.status, 400)
      assert.strictEqual(yield* db.session.readyAt(worker), readyAt)
      assert.strictEqual(yield* pid(), reportedPid)

      const badPid = yield* ready(JSON.stringify({ pid: "x" }))
      assert.strictEqual(badPid.status, 400)
      assert.strictEqual((badPid.body as { _tag?: string })._tag, "InvalidRequestError")
      assert.strictEqual(yield* db.session.readyAt(worker), readyAt)
      assert.strictEqual(yield* pid(), reportedPid)

      const empty = yield* ready("{}")
      assert.deepStrictEqual(empty, { status: 200, body: { process } })
      assert.isNumber(yield* db.session.readyAt(worker))
      assert.strictEqual(yield* pid(), reportedPid)

      const numbered = yield* ready(JSON.stringify({ pid: 1 }))
      assert.deepStrictEqual(numbered, { status: 200, body: { process } })
      assert.strictEqual(pidOf((yield* db.session.getSession(worker))!), 1)
    }),
  )

  test(
    "/api/hook/<harness>/guard runs guardInputOf and formats allow/deny through adapter.guardAnswer for claude, cursor, and agy",
    Effect.gen(function* () {
      const { call, key, repo, sessions, worker } = yield* project

      const { id: cursorId } = yield* sessions.spawn({
        agent: "general",
        machine: { id: "local" },
        root: repo,
        parentSessionId: "creator",
        projectId: key,
        name: "Cursor guard",
        prompt: "do it",
        runtime: "herdr",
        harness: "cursor",
      })

      const { id: agyId } = yield* sessions.spawn({
        agent: "general",
        machine: { id: "local" },
        root: repo,
        parentSessionId: "creator",
        projectId: key,
        name: "Agy guard",
        prompt: "do it",
        runtime: "herdr",
        harness: "agy",
      })

      const identityReason =
        "vibest runs with the agent's own VIBEST_SESSION_ID; a command that changes or clears it is refused."

      const claudeAllow = yield* call(
        "/api/hook/claude/guard",
        { sessionId: worker, harness: "claude" },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: repo }),
      )

      assert.deepStrictEqual(claudeAllow, { status: 200, body: {} })

      const claudeDeny = yield* call(
        "/api/hook/claude/guard",
        { sessionId: worker, harness: "claude" },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "VIBEST_SESSION_ID=other vibest ls" }, cwd: repo }),
      )

      assert.deepStrictEqual(claudeDeny, { status: 200, body: { deny: identityReason } })

      const cursorAllow = yield* call(
        "/api/hook/cursor/guard",
        { sessionId: cursorId, harness: "cursor" },
        JSON.stringify({ tool_name: "Shell", tool_input: { command: "git status" }, cwd: repo }),
      )

      assert.deepStrictEqual(cursorAllow, { status: 200, body: { permission: "allow" } })

      const cursorDeny = yield* call(
        "/api/hook/cursor/guard",
        { sessionId: cursorId, harness: "cursor" },
        JSON.stringify({ tool_name: "Shell", tool_input: { command: "VIBEST_SESSION_ID=other vibest ls" }, cwd: repo }),
      )

      assert.deepStrictEqual(cursorDeny, {
        status: 200,
        body: { permission: "deny", user_message: identityReason, agent_message: identityReason },
      })

      const agyUnmapped = yield* call(
        "/api/hook/agy/guard",
        { sessionId: agyId, harness: "agy" },
        JSON.stringify({ cwd: repo, toolCall: { name: "list_dir", args: {} } }),
      )

      assert.deepStrictEqual(agyUnmapped, { status: 200, body: { decision: "allow" } })

      const agyAllow = yield* call(
        "/api/hook/agy/guard",
        { sessionId: agyId, harness: "agy" },
        JSON.stringify({ cwd: repo, toolCall: { name: "run_command", args: { CommandLine: "git status" } } }),
      )

      assert.deepStrictEqual(agyAllow, { status: 200, body: { decision: "allow" } })

      const agyDeny = yield* call(
        "/api/hook/agy/guard",
        { sessionId: agyId, harness: "agy" },
        JSON.stringify({
          cwd: repo,
          toolCall: { name: "run_command", args: { CommandLine: "VIBEST_SESSION_ID=other vibest ls" } },
        }),
      )

      assert.deepStrictEqual(agyDeny, { status: 200, body: { decision: "deny", reason: identityReason } })

      const agyMalformed = yield* call("/api/hook/agy/guard", { sessionId: agyId, harness: "agy" }, "not json")
      assert.strictEqual(agyMalformed.status, 200)
      assert.strictEqual((agyMalformed.body as { decision: string }).decision, "deny")
      assert.include((agyMalformed.body as { reason: string }).reason, "vibest could not check this tool call")
    }),
  )
})
