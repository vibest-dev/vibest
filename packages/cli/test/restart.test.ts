import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { executionStateOf, exitedAt, pidOf } from "@vibest/core/database/db-rows"
import { line } from "@vibest/core/inbox"
import { noticeEnvelope } from "@vibest/core/replies"
import { Session } from "@vibest/core/session"
import { SessionLive, type Restarted } from "@vibest/core/session/live"
import { CONTINUE, continueText } from "@vibest/core/session/restart"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { VibestCommand } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { Clock, Effect, Fiber, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"

import { daemonPlan } from "../src/update.ts"
import { VERSION } from "../src/version.ts"
import {
  CLAUDE,
  CURSOR,
  entryPending,
  eventsOf,
  PI,
  FakeProcesses,
  FakeRuntime,
  makeRepository,
  restartSessions,
  testLayer,
  type TestServices,
  until,
  untilVirtual,
  writeEnd,
  projectOf,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () =>
    program.pipe(Effect.provide(testLayer({ harnesses: [{ ...PI, inbox: "subscribe" }, CLAUDE, CURSOR] }))),
  )

describe("vibest update's plan for vibestd", () => {
  const target = { version: "2.0.0", command: ["/v/2/bin/vibest"] }
  const ping = { protocol: PROTOCOL, version: "1.0.0", command: ["/v/1/bin/vibest"], instance: "i" }
  it("keeps, hands off or restarts, as Ping says; same version from another binary (npm over curl) is handed off", () => {
    assert.strictEqual(daemonPlan(undefined, target).action, "none")
    assert.strictEqual(daemonPlan({ ...ping, version: "2.0.0", command: target.command }, target).action, "keep")
    assert.strictEqual(daemonPlan({ ...ping, capabilities: { handoff: true } }, target).action, "handoff")
    assert.strictEqual(daemonPlan(ping, target).action, "restart")
    assert.strictEqual(
      daemonPlan({ ...ping, version: "2.0.0", capabilities: { handoff: true } }, target).action,
      "handoff",
    )
  })
})

const busyPiSubagent = Effect.gen(function* () {
  const db = yield* Db.Service
  const sessions = yield* Session.Service
  const repo = yield* makeRepository
  const key = yield* projectOf(repo)
  yield* db.session.startEntry(
    key,
    "pi",
    false,
    { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } },
    { agent: "coordinator" },
  )
  const { id } = yield* sessions.spawn({
    agent: "general",
    machine: { id: "local" },
    root: repo,
    parentSessionId: "creator",
    projectId: key,
    name: "t",
    prompt: "do it",
    runtime: "herdr",
    harness: "pi",
  })
  yield* until(db.session.getSession(id), (w) => !!w && (w.process?.placedAt ?? null) !== null)
  yield* sessions.check(id)
  const pid = (yield* db.session.getSession(id))!.process!.pid!
  return { db, sessions, id, pid }
})

describe("restart in place", () => {
  test(
    "a restart mid-execution: SIGTERM to the harness pid only, its exit and aborted execution end not recorded while it is down, the same terminal runs it again on the same conversation, then one continue and an execution end that sends nothing",
    Effect.gen(function* () {
      const { db, sessions, id, pid } = yield* busyPiSubagent
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const outcomes = yield* Ref.make<ReadonlyArray<Restarted> | undefined>(undefined)
      const ran = yield* herdr.hold("run")
      yield* Effect.forkChild(sessions.restart([id]).pipe(Effect.flatMap((r) => Ref.set(outcomes, r))))
      yield* ran.reached
      assert.deepStrictEqual(yield* processes.signaled, [pid])
      assert.isTrue(yield* (yield* SessionLive.Service).restarting.has(id))
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false, status: "idle" }))
      yield* writeEnd(id, "pi", { text: "", error: "aborted", aborted: true })
      yield* sessions.check(id)
      yield* sessions.send(id, "queued meanwhile")
      const down = (yield* db.session.getSession(id))!
      assert.isNull(exitedAt(down))
      assert.strictEqual(executionStateOf(down), "open")
      assert.deepStrictEqual(yield* entryPending(db, down.projectId), [])
      assert.isUndefined(yield* db.session.readyAt(id), "the old harness's ready report is gone")
      assert.isUndefined(pidOf(down), "so is its pid")
      const opened = (yield* herdr.callsTo("open")).length
      yield* db.session.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* ran.release()
      const [run] = yield* herdr.callsTo("run")
      assert.strictEqual(run!.argv[0], "pi")
      assert.includeMembers([...run!.argv], ["--session-id", (down.process?.conversation ?? null)!])
      const [outcome] = (yield* untilVirtual(Ref.get(outcomes), (o) => o !== undefined))!
      assert.deepInclude(outcome, { id, ok: true, message: `${id} restarted; its interrupted execution continues` })
      assert.strictEqual((yield* herdr.callsTo("open")).length, opened, "no new terminal")
      const row = (yield* db.session.getSession(id))!
      assert.isFalse(yield* (yield* SessionLive.Service).restarting.has(id))
      assert.notStrictEqual(row.process?.pid, pid)
      assert.strictEqual(executionStateOf(row), "open")
      assert.include(
        (yield* herdr.callsTo("send")).map((s) => s.text),
        noticeEnvelope(continueText(VERSION)),
      )
      yield* herdr.seedAgent("test/coord")
      yield* writeEnd(id, "pi", { text: "done\nstatus: completed" })
      yield* herdr.endExecution(id)
      yield* sessions.check(id)
      assert.deepStrictEqual(yield* entryPending(db, row.projectId), [])
      assert.include((yield* db.session.latestReply(id))!.text, "done")
    }),
  )

  test(
    "a second restart of an agent already being restarted joins it: one signal, one run, one continue notice, both callers get the result",
    Effect.gen(function* () {
      const { db, sessions, id, pid } = yield* busyPiSubagent
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const ran = yield* herdr.hold("run")
      const first = yield* Effect.forkChild(sessions.restart([id]))
      yield* ran.reached
      const second = yield* Effect.forkChild(sessions.restart([id, id]))
      yield* Effect.yieldNow
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false, status: "idle" }))
      yield* db.session.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* ran.release()
      const outcomes = [yield* Fiber.join(first), yield* Fiber.join(second)]
      assert.deepStrictEqual(
        outcomes.map((o) => o.map((r) => r.ok)),
        [[true], [true]],
      )
      assert.deepStrictEqual(yield* processes.signaled, [pid])
      assert.lengthOf(yield* herdr.callsTo("run"), 1)
      assert.lengthOf(
        (yield* herdr.callsTo("send")).filter((s) => s.text === noticeEnvelope(continueText(VERSION))),
        1,
      )
    }),
  )

  it("an entry session's continue notice: the line its delivery shows carries the instruction, even on a long version", () => {
    const version = "10.20.300-beta.4000+build.5"
    const shown = line([{ kind: "notice", message: noticeEnvelope(continueText(version)) } as never], () => undefined)
    assert.isTrue(shown.startsWith(`Notice: ${CONTINUE}`))
  })

  const workingEntry = (harness: "cursor" | "pi") =>
    Effect.gen(function* () {
      const db = yield* Db.Service
      const herdr = yield* FakeRuntime
      const projectId = yield* projectOf(yield* makeRepository)
      yield* db.session.startEntry(
        projectId,
        harness,
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      yield* herdr.seedAgent("test/coord")
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "working" }))
      const entry = (yield* db.session.entryOf(projectId))!
      yield* db.session.noteConversation(entry.id, "conversation-1")
      yield* db.session.patchLive(entry.id, { pid: 100 })
      return { db, herdr, id: entry.id, projectId }
    })

  test(
    "a Cursor entry session (no integration reports its pid or its readiness): never listed as outdated, and a restart asked for anyway signals and runs nothing",
    Effect.gen(function* () {
      const { herdr, id } = yield* workingEntry("cursor")
      const sessions = yield* Session.Service
      const processes = yield* FakeProcesses
      assert.deepStrictEqual(yield* sessions.outdated, [])
      const [outcome] = yield* sessions.restart([id])
      assert.deepInclude(outcome, { id, ok: false })
      assert.include(outcome!.message, "start it again yourself")
      assert.deepStrictEqual(yield* processes.signaled, [])
      assert.deepStrictEqual(yield* herdr.callsTo("run"), [])
    }),
  )

  test(
    "a Pi entry session (inbox subscribe) with an open execution, after its idle subagent: waits for its integration's ready report even when the runtime sees it idle, then the continue notice is typed into the execution it continues",
    Effect.gen(function* () {
      const { db, sessions, id: sub, pid } = yield* busyPiSubagent
      const processes = yield* FakeProcesses
      const herdr = yield* FakeRuntime
      const projectId = (yield* db.session.getSession(sub))!.projectId
      const entryId = (yield* db.session.entryOf(projectId))!.id
      yield* herdr.seedAgent("test/coord")
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "working" }))
      yield* db.session.noteConversation(entryId, "conversation-1")
      yield* db.session.patchLive(entryId, { pid: 400 })
      yield* db.session.startObserved(entryId, "work in flight", 1)
      const interrupted = yield* db.session.openExecution(entryId)
      assert.isDefined(interrupted)
      yield* herdr.endExecution(sub)
      yield* Ref.set(herdr.onStarted, (session) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((at) =>
            db.session.patchLive(session, {
              ready: at,
              pid: 600,
              integration: { version: VERSION, protocol: PROTOCOL },
            }),
          ),
        ),
      )
      const outcomes = yield* Ref.make<ReadonlyArray<Restarted> | undefined>(undefined)
      yield* Effect.forkChild(sessions.restart([entryId, sub]).pipe(Effect.flatMap((r) => Ref.set(outcomes, r))))
      yield* until(herdr.callsTo("run"), (runs) => runs.some((r) => r.argv[0] === "env"))
      yield* until(processes.signaled, (signaled) => [pid, 400].every((p) => signaled.includes(p)))
      yield* db.session.patchLive(entryId, { pid: 500, ready: null })
      yield* db.session.noteIntegration(entryId, { version: VERSION, protocol: PROTOCOL })
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "idle" }))
      yield* TestClock.adjust("5 seconds")
      assert.isUndefined(yield* Ref.get(outcomes), "not done before the integration's ready report")
      yield* db.session.patchLive(entryId, { ready: 2 })
      const done = (yield* untilVirtual(Ref.get(outcomes), (o) => o !== undefined))!
      assert.sameDeepMembers(
        done.map((o) => [o.id, o.ok]),
        [
          [sub, true],
          [entryId, true],
        ],
      )
      assert.deepStrictEqual(yield* entryPending(db, projectId), [], "the continuation waits behind nothing")
      assert.strictEqual(yield* db.session.openExecution(entryId), interrupted, "the interrupted execution stays open")
      assert.include(
        (yield* herdr.callsTo("send")).map((c) => c.text),
        noticeEnvelope(continueText(VERSION)),
        "the continuation is typed into the execution it continues",
      )
      const entryArgv = (yield* herdr.callsTo("run")).map((c) => c.argv).find((argv) => argv[0] === "env")
      assert.ok(entryArgv, "the entry session is restarted by typing env")
      assert.ok(entryArgv!.includes(`VIBEST_SESSION_ID=${entryId}`))
      assert.ok(entryArgv!.includes("pi"))
      const identity = new Set([
        "VIBEST_SESSION_ID",
        "VIBEST_PROJECT_ID",
        "VIBEST_PROJECT_DIR",
        "VIBEST_AGENT",
        "VIBEST_HARNESS",
        "VIBEST_RUNTIME",
        "VIBEST_HOME",
        "VIBEST_COMMAND",
      ])
      for (const pair of entryArgv!.slice(1, entryArgv!.indexOf("pi")))
        assert.ok(identity.has(pair.slice(0, pair.indexOf("="))), pair)
    }).pipe(Effect.provideService(VibestCommand, ["/own/bin/vibest"])),
  )

  test(
    "an entry session the runtime calls idle still continues when the update command is running in its process tree",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const sessions = yield* Session.Service
      const processes = yield* FakeProcesses
      const herdr = yield* FakeRuntime
      const projectId = yield* projectOf(yield* makeRepository)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      yield* herdr.seedAgent("test/coord")
      const id = (yield* db.session.entryOf(projectId))!.id
      yield* db.session.noteConversation(id, "conversation-1")
      yield* db.session.patchLive(id, { pid: 400 })
      yield* db.session.startObserved(id, "work in flight", 1)
      yield* processes.setTree(400, [400, 900])
      const held = yield* herdr.hold("run")
      yield* Effect.forkChild(sessions.restartLater([id], 900))
      yield* held.reached
      yield* db.session.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* db.session.patchLive(id, { ready: 2, pid: 500 })
      yield* held.release()
      yield* untilVirtual(herdr.callsTo("send").pipe(Effect.map((calls) => calls.map((c) => c.text))), (texts) =>
        texts.includes(noticeEnvelope(continueText(VERSION))),
      )
      assert.deepStrictEqual(yield* entryPending(db, projectId), [])
    }).pipe(Effect.provideService(VibestCommand, ["/own/bin/vibest"])),
  )

  test(
    "a ready report records the integration it names, not whatever an older report left noted",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const projectId = yield* projectOf(yield* makeRepository)
      yield* db.session.startEntry(
        projectId,
        "pi",
        false,
        {
          runtime: RUNTIME,
          address: { machine: "local", id: "test/coord" },
        },
        { agent: "coordinator" },
      )
      const id = (yield* db.session.entryOf(projectId))!.id
      yield* db.session.noteConversation(id, "conversation-1")
      yield* db.session.noteIntegration(id, { version: "0.0.0-old", protocol: PROTOCOL })
      yield* db.session.patchLive(id, { ready: 1, pid: 500, integration: { version: VERSION, protocol: PROTOCOL } })
      const ready = (yield* eventsOf(id, "process.ready")).at(-1)
      assert.deepStrictEqual(ready?.data.integration, { version: VERSION, protocol: PROTOCOL })
      assert.strictEqual(ready?.data.pid, 500)
    }),
  )

  test(
    "the old harness's report after the new process.start is not its answer, even for a fresh Session service",
    Effect.gen(function* () {
      const { db, sessions, id, pid } = yield* busyPiSubagent
      const herdr = yield* FakeRuntime
      yield* db.session.noteConversation(id, "conv-1")
      const held = yield* herdr.hold("run", id)
      const outcomes = yield* Ref.make<ReadonlyArray<Restarted> | undefined>(undefined)
      yield* Effect.forkChild(sessions.restart([id]).pipe(Effect.flatMap((rows) => Ref.set(outcomes, rows))))
      yield* held.reached
      const [restarted] = (yield* eventsOf(id, "process.started")).slice(-1)
      yield* writeEnd(id, "pi", { text: "status: completed\nsummary: old harness" })
      assert.isAbove(restarted!.id, 0)
      assert.lengthOf(yield* eventsOf(id, "execution.ended"), 0)
      yield* db.session.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* held.release()
      const [outcome] = (yield* untilVirtual(Ref.get(outcomes), (rows) => rows !== undefined))!
      assert.strictEqual(outcome?.ok, true, outcome?.message)
      assert.notStrictEqual((yield* db.session.getSession(id))!.process?.pid, pid)
      yield* sessions.check(id)
      const freshSessions = yield* restartSessions
      yield* freshSessions.check(id)
      assert.strictEqual((yield* eventsOf(id, "execution.ended")).length, 0)
      assert.isUndefined(yield* db.session.latestReply(id))
    }),
  )
})
