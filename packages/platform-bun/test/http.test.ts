import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { pidOf } from "@vibest/core/database/db-rows"
import { Inbox } from "@vibest/core/inbox"
import { Session } from "@vibest/core/session"
import { sessionHeaders, type SessionIdentity } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { PROTOCOL } from "@vibest/schema/version"
import * as Http from "@vibest/server/http"
import { Clock, Effect, Logger, Predicate, type Schema, type Scope } from "effect"
import * as Headers from "effect/http/Headers"
import { CurrentLogAnnotations } from "effect/References"
import { TestClock } from "effect/testing"

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
} from "./lib/fakes.ts"

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

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () =>
    program.pipe(Effect.provide(testLayer({ harnesses: [{ ...CLAUDE, delivery: "pull" }, PI, CURSOR, AGY] }))),
  )

const project = Effect.gen(function* () {
  const db = yield* Db.Service
  const herdr = yield* FakeRuntime
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
  const handle = yield* Http.make

  const call = (path: string, who: Partial<SessionIdentity> & { sessionId: string }, body = "{}") =>
    handle({
      path,
      headers: Headers.fromInput(sessionHeaders({ projectId: String(projectId), harness: "claude", ...who })),
      body,
    })

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

describe("vibestd's HTTP API", () => {
  test(
    "a late Ready from the process a restart replaced changes nothing; the restarted harness's Ready is taken",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      yield* until(db.session.getSession(worker), (s) => (s ? (s.process?.placedAt ?? null) : undefined) != null)
      const first = (yield* db.session.currentProcessId(worker))!

      const ready = (process: number, pid: number, pluginVersion = VERSION) =>
        call("/session/ready", { sessionId: worker, process: String(process), pluginVersion }, JSON.stringify({ pid }))

      assert.deepStrictEqual((yield* ready(first, 111)).body, { process: first })
      yield* db.session.restartProcess(worker)
      const second = (yield* db.session.currentProcessId(worker))!
      assert.notStrictEqual(second, first)
      const late = yield* ready(first, 111)
      assert.strictEqual(late.status, 204)
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
    "Ready takes {} and a numeric pid; a malformed body or a wrong pid type is 400 with the decode message and changes nothing",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      yield* until(db.session.getSession(worker), (s) => (s ? (s.process?.placedAt ?? null) : undefined) != null)
      const process = (yield* db.session.currentProcessId(worker))!
      const ready = (body: string) => call("/session/ready", { sessionId: worker, process: String(process) }, body)
      const pid = () => Effect.map(db.session.getSession(worker), (session) => pidOf(session!))
      const readyAt = yield* db.session.readyAt(worker)
      const reportedPid = yield* pid()
      yield* TestClock.adjust("1 second")
      const now = yield* Clock.currentTimeMillis

      const logEntry = ({ fiber, logLevel, message }: Logger.Options<unknown>) => ({
        message,
        level: logLevel,
        annotations: { ...fiber.getRef(CurrentLogAnnotations) },
      })

      const logs: Array<ReturnType<typeof logEntry>> = []

      const watched = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(
            Logger.layer([
              Logger.make((options) => {
                logs.push(logEntry(options))
              }),
            ]),
          ),
        )

      const rejected = (body: string, message: string) =>
        Effect.gen(function* () {
          const reply = yield* watched(ready(body))
          assert.strictEqual(reply.status, 400)
          assert.deepStrictEqual(reply.body, Http.InvalidRequestError.make({ message, kind: "Payload" }))
          assert.deepStrictEqual(logs.at(-1), {
            message: ["schema rejection"],
            level: "Warn",
            annotations: { kind: "Payload", reason: message },
          })
          assert.strictEqual(yield* db.session.readyAt(worker), readyAt)
          assert.strictEqual(yield* pid(), reportedPid)
        })

      yield* rejected("{", "Expected a valid JSON string")
      yield* rejected(JSON.stringify({ pid: "x" }), 'Expected number | undefined\n  at ["pid"]')
      const empty = yield* ready("{}")
      assert.deepStrictEqual(empty, { status: 200, body: { process } })
      assert.strictEqual(yield* db.session.readyAt(worker), now)
      assert.strictEqual(yield* pid(), reportedPid)
      const numbered = yield* ready(JSON.stringify({ pid: 1 }))
      assert.deepStrictEqual(numbered, { status: 200, body: { process } })
      assert.strictEqual(pidOf((yield* db.session.getSession(worker))!), 1)
    }),
  )

  test(
    "/hooks/<harness>/guard runs guardInputOf and formats allow/deny through adapter.guardAnswer for claude, cursor, and agy",
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
        "/hooks/claude/guard",
        { sessionId: worker, harness: "claude" },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: repo }),
      )

      assert.deepStrictEqual(claudeAllow, { status: 200, body: {} })

      const claudeDeny = yield* call(
        "/hooks/claude/guard",
        { sessionId: worker, harness: "claude" },
        JSON.stringify({ tool_name: "Bash", tool_input: { command: "VIBEST_SESSION_ID=other vibest ls" }, cwd: repo }),
      )

      assert.deepStrictEqual(claudeDeny, { status: 200, body: { deny: identityReason } })

      const cursorAllow = yield* call(
        "/hooks/cursor/guard",
        { sessionId: cursorId, harness: "cursor" },
        JSON.stringify({ tool_name: "Shell", tool_input: { command: "git status" }, cwd: repo }),
      )

      assert.deepStrictEqual(cursorAllow, { status: 200, body: { permission: "allow" } })

      const cursorDeny = yield* call(
        "/hooks/cursor/guard",
        { sessionId: cursorId, harness: "cursor" },
        JSON.stringify({ tool_name: "Shell", tool_input: { command: "VIBEST_SESSION_ID=other vibest ls" }, cwd: repo }),
      )

      assert.deepStrictEqual(cursorDeny, {
        status: 200,
        body: { permission: "deny", user_message: identityReason, agent_message: identityReason },
      })

      const agyUnmapped = yield* call(
        "/hooks/agy/guard",
        { sessionId: agyId, harness: "agy" },
        JSON.stringify({ cwd: repo, toolCall: { name: "list_dir", args: {} } }),
      )

      assert.deepStrictEqual(agyUnmapped, { status: 200, body: { decision: "allow" } })

      const agyAllow = yield* call(
        "/hooks/agy/guard",
        { sessionId: agyId, harness: "agy" },
        JSON.stringify({ cwd: repo, toolCall: { name: "run_command", args: { CommandLine: "git status" } } }),
      )

      assert.deepStrictEqual(agyAllow, { status: 200, body: { decision: "allow" } })

      const agyDeny = yield* call(
        "/hooks/agy/guard",
        { sessionId: agyId, harness: "agy" },
        JSON.stringify({
          cwd: repo,
          toolCall: { name: "run_command", args: { CommandLine: "VIBEST_SESSION_ID=other vibest ls" } },
        }),
      )

      assert.deepStrictEqual(agyDeny, { status: 200, body: { decision: "deny", reason: identityReason } })

      const agyMalformed = yield* call("/hooks/agy/guard", { sessionId: agyId, harness: "agy" }, "not json")
      assert.strictEqual(agyMalformed.status, 200)
      assert.strictEqual((agyMalformed.body as { decision: string }).decision, "deny")
      assert.include((agyMalformed.body as { reason: string }).reason, "vibest could not check this tool call")
    }),
  )
})
