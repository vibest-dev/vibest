import { assert, describe, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { line } from "@vibest/core/inbox"
import { CONTINUE, continueNotice, continueText, type Restarted } from "@vibest/core/restart"
import { Restarting } from "@vibest/core/restarting"
import { Sessions } from "@vibest/core/sessions"
import { PROTOCOL } from "@vibest/protocol/protocol"
import { VERSION } from "@vibest/protocol/rpc"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import { Effect, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"

import { daemonPlan } from "../src/cli.ts"
import {
  eventsOf,
  FakeProcesses,
  FakeRuntime,
  makeRepository,
  testLayer,
  type TestServices,
  until,
  untilVirtual,
  writeResult,
  projectOf,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer())))

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
  const db = yield* Db
  const sessions = yield* Sessions
  const repo = yield* makeRepository
  const key = yield* projectOf(repo)
  yield* db.coordinatorLaunch(key, "pi", false, { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } })
  const { id } = yield* sessions.spawn({
    machine: { id: "local" },
    root: repo,
    projectId: key,
    name: "t",
    prompt: "do it",
    harness: "pi",
  })
  yield* until(db.getSession(id), (w) => !!w && w.startedAt !== null)
  yield* sessions.check(id)
  const pid = (yield* db.getSession(id))!.metadata.pid!
  return { db, sessions, id, pid }
})

describe("restart in place", () => {
  test(
    "outdated lists an agent whose integration is not this vibestd's; one that reported this version is current",
    Effect.gen(function* () {
      const { db, sessions, id } = yield* busyPiSubagent
      assert.deepStrictEqual(
        (yield* sessions.outdated).map((a) => [a.id, a.integration, a.working, a.blocked]),
        [[id, null, true, null]],
      )
      yield* db.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      assert.deepStrictEqual(yield* sessions.outdated, [])
      yield* db.noteIntegration(id, { version: "0.0.1", protocol: PROTOCOL })
      assert.strictEqual((yield* sessions.outdated)[0]?.integration, "0.0.1")
    }),
  )

  test(
    "a restart mid-turn: SIGTERM to the harness pid only, its exit and aborted turn end not recorded while it is down, the same terminal runs it again on the same conversation, then one continue and one result (pending for an idle Pi main agent, which takes its rows itself)",
    Effect.gen(function* () {
      const { db, sessions, id, pid } = yield* busyPiSubagent
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const outcomes = yield* Ref.make<ReadonlyArray<Restarted> | undefined>(undefined)
      const ran = yield* herdr.hold("run")
      yield* Effect.forkChild(sessions.restart([id]).pipe(Effect.flatMap((r) => Ref.set(outcomes, r))))
      yield* ran.reached
      assert.deepStrictEqual(yield* processes.signaled, [pid])
      assert.isTrue((yield* Restarting).has(id))
      yield* herdr.updateAgent(id, (a) => ({ ...a, alive: false, status: "idle" }))
      yield* writeResult(id, "pi", { text: "", error: "aborted", aborted: true })
      yield* sessions.check(id)
      yield* sessions.send(id, "queued meanwhile")
      const down = (yield* db.getSession(id))!
      assert.deepInclude(down, { exitedAt: null, turnState: "open" })
      assert.deepStrictEqual(yield* db.coordinatorPending(down.projectId), [])
      assert.isUndefined(yield* db.readyAt(id), "the old harness's ready report is gone")
      assert.isUndefined(down.metadata.pid, "so is its pid")
      const opened = (yield* herdr.callsTo("open")).length
      yield* db.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* ran.release()
      const [run] = yield* herdr.callsTo("run")
      assert.strictEqual(run!.argv[0], "pi")
      assert.includeMembers([...run!.argv], ["--session-id", down.harnessSessionId!])
      const [outcome] = (yield* untilVirtual(Ref.get(outcomes), (o) => o !== undefined))!
      assert.deepInclude(outcome, { id, ok: true, message: `${id} restarted; its interrupted turn continues` })
      assert.strictEqual((yield* herdr.callsTo("open")).length, opened, "no new terminal")
      const row = (yield* db.getSession(id))!
      assert.isFalse((yield* Restarting).has(id))
      assert.notStrictEqual(row.metadata.pid, pid)
      assert.strictEqual(row.turnState, "open")
      assert.include(
        (yield* herdr.callsTo("send")).map((s) => s.text),
        continueText(VERSION),
      )
      yield* herdr.seedAgent("test/coord")
      yield* writeResult(id, "pi", { text: "done\nstatus: completed" })
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      const results = (yield* db.coordinatorPending(row.projectId)).filter((r) => r.kind === "result")
      assert.lengthOf(results, 1)
      assert.include(results[0]!.message, "done")
    }),
  )

  it("a main agent's continue notice: the line its delivery shows carries the instruction, even on a long version", () => {
    const version = "10.20.300-beta.4000+build.5"
    const notice = continueNotice(version, [
      {
        id: "ab12cd34-ab12-4ab1-8ab1-ab12cd34ab12",
        projectId: "0e0e0000-0e0e-40e0-80e0-0e0e00000e0e",
        ok: true,
        message: "",
      },
    ])
    const shown = line([{ kind: "notice", message: notice } as never], () => undefined)
    assert.strictEqual(shown, `Notice: ${CONTINUE}`)
    assert.include(shown, "do not run it again, continue the interrupted work.")
    assert.include(notice, `vibest is now ${version}.`)
    assert.include(notice, "Restarted: ab12cd34-ab12-4ab1-8ab1-ab12cd34ab12.")
  })

  const workingMain = (harness: "cursor" | "pi") =>
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const projectId = yield* projectOf(yield* makeRepository)
      yield* db.coordinatorLaunch(projectId, harness, false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* herdr.seedAgent("test/coord")
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "working" }))
      const main = (yield* db.coordinatorOf(projectId))!
      yield* db.reportCoordinatorSession(main.id, harness, "conversation-1")
      yield* db.patchLive(main.id, { pid: 100 })
      return { db, herdr, id: main.id, projectId }
    })

  test(
    "a Cursor main agent (no integration reports its pid or its readiness): never listed as outdated, and a restart asked for anyway signals and runs nothing",
    Effect.gen(function* () {
      const { herdr, id } = yield* workingMain("cursor")
      const sessions = yield* Sessions
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
    "a main agent that ran vibest update itself: working when it asked, idle once the update returned, restarted only after the update process exits, it still gets the continue notice",
    Effect.gen(function* () {
      const updatePid = 900
      const { db, herdr, id, projectId } = yield* workingMain("pi")
      const sessions = yield* Sessions
      const processes = yield* FakeProcesses
      yield* processes.set(updatePid, "alive")
      yield* sessions.restartLater([id], updatePid)
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "idle" }))
      yield* TestClock.adjust("2 seconds")
      assert.deepStrictEqual(yield* processes.signaled, [], "nothing ended while the update still runs")
      yield* processes.set(updatePid, "exited")
      yield* untilVirtual(processes.signaled, (t) => t.includes(100))
      yield* db.patchLive(id, { pid: 300, ready: null })
      yield* db.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* db.patchLive(id, { ready: 1 })
      const notices = yield* untilVirtual(
        db.coordinatorPending(projectId).pipe(Effect.map((rows) => rows.filter((r) => r.kind === "notice"))),
        (rows) => rows.length > 0,
      )
      assert.strictEqual(notices[0]!.message.split("\n")[0], CONTINUE)
    }),
  )

  test(
    "a Pi main agent (inbox subscribe) after its idle subagent: waits for its integration's ready report even when the runtime sees it idle, then its inbox holds one continue notice naming both",
    Effect.gen(function* () {
      const { db, sessions, id: sub, pid } = yield* busyPiSubagent
      const processes = yield* FakeProcesses
      const herdr = yield* FakeRuntime
      const projectId = (yield* db.getSession(sub))!.projectId
      const main = (yield* db.coordinatorOf(projectId))!.id
      yield* herdr.seedAgent("test/coord")
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "working" }))
      yield* db.reportCoordinatorSession(main, "pi", "conversation-1")
      yield* db.patchLive(main, { pid: 400 })
      yield* herdr.endTurn(sub)
      const outcomes = yield* Ref.make<ReadonlyArray<Restarted> | undefined>(undefined)
      yield* Effect.forkChild(sessions.restart([main, sub]).pipe(Effect.flatMap((r) => Ref.set(outcomes, r))))
      yield* until(processes.signaled, (t) => t.includes(pid))
      yield* db.noteIntegration(sub, { version: VERSION, protocol: PROTOCOL })
      yield* untilVirtual(processes.signaled, (t) => t.includes(400))
      assert.deepStrictEqual(yield* processes.signaled, [pid, 400], "the subagent first, the main agent last")
      yield* db.patchLive(main, { pid: 500, ready: null })
      yield* db.noteIntegration(main, { version: VERSION, protocol: PROTOCOL })
      yield* herdr.updateAgent("test/coord", (a) => ({ ...a, status: "idle" }))
      yield* TestClock.adjust("5 seconds")
      assert.isUndefined(yield* Ref.get(outcomes), "not done before the integration's ready report")
      yield* db.patchLive(main, { ready: 2 })
      const done = (yield* untilVirtual(Ref.get(outcomes), (o) => o !== undefined))!
      assert.deepStrictEqual(
        done.map((o) => [o.id, o.ok]),
        [
          [sub, true],
          [main, true],
        ],
      )
      const notices = (yield* db.coordinatorPending(projectId)).filter((r) => r.kind === "notice")
      assert.lengthOf(notices, 1)
      assert.strictEqual(notices[0]!.message.split("\n")[0], CONTINUE)
      assert.include(notices[0]!.message, `Restarted: ${sub}, ${main}.`)
    }),
  )

  test(
    "the old harness's report after the new process.start is not its result, even for a fresh Sessions",
    Effect.gen(function* () {
      const { db, sessions, id, pid } = yield* busyPiSubagent
      const herdr = yield* FakeRuntime
      yield* db.noteHarnessSession(id, "conv-1")
      const held = yield* herdr.hold("run", id)
      const outcomes = yield* Ref.make<ReadonlyArray<Restarted> | undefined>(undefined)
      yield* Effect.forkChild(sessions.restart([id]).pipe(Effect.flatMap((rows) => Ref.set(outcomes, rows))))
      yield* held.reached
      const [restarted] = (yield* eventsOf(id, "process.start")).slice(-1)
      yield* writeResult(id, "pi", { text: "status: completed\nsummary: old harness" })
      assert.isAbove((yield* eventsOf(id, "turn.reported")).at(-1)!.id, restarted!.id)
      yield* db.noteIntegration(id, { version: VERSION, protocol: PROTOCOL })
      yield* held.release()
      const [outcome] = (yield* untilVirtual(Ref.get(outcomes), (rows) => rows !== undefined))!
      assert.strictEqual(outcome?.ok, true, outcome?.message)
      assert.notStrictEqual((yield* db.getSession(id))!.metadata.pid, pid)
      yield* sessions.check(id)
      const freshSessions = yield* Sessions.make({ maxSessions: undefined })
      yield* freshSessions.check(id)
      assert.strictEqual((yield* eventsOf(id, "turn.end")).length, 0)
      assert.isUndefined(yield* db.latestInbox(id, "result"))
    }),
  )
})
