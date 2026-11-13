import { assert, describe, it } from "@effect/vitest"
import { Db, pidOf } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Sessions } from "@vibest/core/sessions"
import { sessionHeaders, type SessionIdentity } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { PROTOCOL, VERSION } from "@vibest/schema/version"
import * as Http from "@vibest/server/http"
import { Effect, type Scope } from "effect"
import * as Headers from "effect/http/Headers"

import {
  CLAUDE,
  CURSOR,
  FakeRuntime,
  PI,
  makeRepository,
  testLayer,
  type TestServices,
  until,
  projectOf,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () =>
    program.pipe(Effect.provide(testLayer({ harnesses: [{ ...CLAUDE, inbox: "poll" }, PI, CURSOR] }))),
  )

const project = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const key = yield* projectOf(repo)
  const entry = yield* db.startEntry(
    key,
    "claude",
    false,
    {
      runtime: RUNTIME,
      address: { machine: "local", id: "test/coord" },
    },
    { agent: "coordinator" },
  )
  yield* herdr.seedAgent("test/coord")
  const sessions = yield* Sessions
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
  return { db, herdr, entryId: entry.sessionId, worker, projectId, repo, key, sessions, call, inbox: yield* Inbox }
})

describe("vibestd's HTTP API", () => {
  test(
    "a late Ready from the process a restart replaced changes nothing; the restarted harness's Ready is taken",
    Effect.gen(function* () {
      const { call, db, worker } = yield* project
      yield* until(db.getSession(worker), (s) => (s ? (s.process?.placedAt ?? null) : undefined) != null)
      const first = (yield* db.currentProcessId(worker))!
      const ready = (process: number, pid: number, pluginVersion = VERSION) =>
        call("/session/ready", { sessionId: worker, process: String(process), pluginVersion }, JSON.stringify({ pid }))
      assert.deepStrictEqual((yield* ready(first, 111)).body, { process: first })
      yield* db.restartProcess(worker)
      const second = (yield* db.currentProcessId(worker))!
      assert.notStrictEqual(second, first)
      const late = yield* ready(first, 111)
      assert.strictEqual(late.status, 204)
      assert.isUndefined(yield* db.readyAt(worker))
      assert.isUndefined(pidOf((yield* db.getSession(worker))!))
      assert.deepStrictEqual((yield* ready(first, 222, "0.0.2-next")).body, { process: second })
      assert.isNumber(yield* db.readyAt(worker))
      assert.deepInclude((yield* db.getSession(worker))!.process, {
        pid: 222,
        integration: { version: "0.0.2-next", protocol: PROTOCOL },
      })
    }),
  )
})
