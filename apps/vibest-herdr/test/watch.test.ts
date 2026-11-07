import fs from "node:fs/promises"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Project } from "@vibest/core/project"
import { sessionHeaders } from "@vibest/protocol/protocol"
import type { WatchEvent } from "@vibest/protocol/rpc"
import * as Server from "@vibest/server/server"
import { Effect, Fiber, Layer, Queue, type Scope, Stream } from "effect"

import * as Platform from "#platform"

import {
  authed,
  FakeRuntime,
  makeRepository,
  projectOf,
  tempDirectory,
  testLayer,
  type TestServices,
  wire,
} from "./fakes.ts"

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.daemon.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)))

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

const withMain = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const project = yield* projectOf(repo)
  yield* herdr.addPane("w1:p8", "ws", repo)
  yield* herdr.seedAgent("w1:p8")
  const main = yield* db.coordinatorLaunch(
    project,
    "pi",
    false,
    { runtime: "herdr", address: { machine: "local", id: "w1:p8" } },
    { projectDirectory: repo },
  )
  const coordinator = authed(yield* client, sessionHeaders({ sessionId: main.sessionId, projectId: project }))
  return { repo, project, main: main.sessionId, coordinator }
})

const watching = (repo: string) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WatchEvent>()
    const c = authed(yield* client, cliHeaders(repo))
    yield* c.Watch(undefined).pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkScoped,
    )
    const next = <A extends WatchEvent>(match: (event: WatchEvent) => event is A) =>
      Effect.gen(function* () {
        for (;;) {
          const event = yield* Queue.take(events)
          if (match(event)) return event
        }
      }).pipe(Effect.timeout("20 seconds"), Effect.orDie)
    return { next, c }
  })

const isSnapshot = (e: WatchEvent): e is Extract<WatchEvent, { _tag: "Snapshot" }> => e._tag === "Snapshot"

describe("Watch", () => {
  test(
    "a Snapshot of projects and sessions, then each change as it commits: subagents name their main agent",
    Effect.gen(function* () {
      const { repo, project, main, coordinator } = yield* withMain
      const { next, c } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      assert.deepStrictEqual(snapshot.projects, [
        { id: project, directory: repo, entrySessionId: main, activity: "idle" },
      ])
      assert.deepStrictEqual(
        snapshot.sessions.map((s) => [s.id, s.agent, s.parentId]),
        [[main, "main", null]],
      )

      const { id } = yield* coordinator.Spawn({ harness: "pi", prompt: "do it" })
      const spawned = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          e._tag === "Session" && e.session.id === id && e.session.turnState === "open",
      )
      assert.strictEqual(spawned.session.parentId, main)
      assert.strictEqual(spawned.session.projectId, project)
      assert.strictEqual(spawned.session.task, "do it")

      const other = yield* makeRepository
      const opened = yield* authed(yield* client, cliHeaders(other))["Project.Open"]({})
      const seen = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> => e._tag === "Project" && e.project.directory === other,
      )
      assert.deepStrictEqual(seen.project, {
        id: opened.projectId,
        directory: other,
        entrySessionId: null,
        activity: "idle",
      })

      yield* c.Remove({ id })
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "SessionEnded" }> =>
          e._tag === "SessionEnded" && e.id === id && e.projectId === project,
      )
    }),
  )

  test(
    "a project move sends the sessions it moved again, with their new directories",
    Effect.gen(function* () {
      const db = yield* Db
      const { repo, project, main } = yield* withMain
      const { next } = yield* watching(repo)
      yield* next(isSnapshot)
      const moved = `${yield* tempDirectory("vibest-moved-")}/repo`
      yield* Effect.promise(() => fs.cp(repo, moved, { recursive: true }))
      yield* db.moveProject(project, moved, [])
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          e._tag === "Session" && e.session.id === main && e.session.worktree === moved,
      )
    }),
  )

  test(
    "a session started while Watch reads its Snapshot is in the Snapshot or arrives after it",
    Effect.gen(function* () {
      const { repo, coordinator } = yield* withMain
      const spawn = yield* coordinator.Spawn({ harness: "pi", prompt: "race" }).pipe(Effect.forkScoped)
      const { next } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      const { id } = yield* Fiber.join(spawn)
      if (!snapshot.sessions.some((s) => s.id === id))
        yield* next((e): e is Extract<WatchEvent, { _tag: "Session" }> => e._tag === "Session" && e.session.id === id)
    }),
  )

  test(
    "a turn that ends unwatched is done, for the session and its project, until Session.Seen raises the mark to it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const { repo, project, coordinator } = yield* withMain
      const { next, c } = yield* watching(repo)
      yield* next(isSnapshot)
      const { id } = yield* coordinator.Spawn({ harness: "pi", prompt: "do it" })
      const isSession = (status: string, turn: number) => (e: WatchEvent) =>
        e._tag === "Session" && e.session.id === id && e.session.status === status && e.session.turn === turn
      yield* next((e): e is WatchEvent => isSession("working", 0)(e))
      const terminal = (yield* herdr.terminalOf(id))!
      yield* herdr.endTurn(id)
      yield* db.updateSession(id, { status: "idle" })
      const isProject = (activity: string) => (e: WatchEvent) =>
        e._tag === "Project" && e.project.id === project && e.project.activity === activity
      yield* next((e): e is WatchEvent => isSession("idle", 0)(e))
      yield* herdr.finishTurn(terminal.id)
      yield* next((e): e is WatchEvent => isSession("done", 1)(e))
      yield* next((e): e is WatchEvent => isProject("done")(e))

      yield* c["Session.Seen"]({ id, turn: 2 })
      yield* c["Session.Seen"]({ id, turn: 0 })
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { turn: 1, seen: 0 })
      yield* c["Session.Seen"]({ id, turn: 1 })
      yield* next((e): e is WatchEvent => isSession("idle", 1)(e))
      yield* next((e): e is WatchEvent => isProject("idle")(e))
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { turn: 1, seen: 1 })
      assert.strictEqual(
        (yield* Effect.flip(coordinator["Session.Seen"]({ id, turn: 1 })))._tag,
        "Forbidden",
        "only the user marks what they saw",
      )
    }),
  )

  test(
    "overlapping Session.Seen calls on one terminal run one after another, so the mark ends at the higher turn",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { repo, coordinator } = yield* withMain
      const { next, c } = yield* watching(repo)
      yield* next(isSnapshot)
      const { id } = yield* coordinator.Spawn({ harness: "pi", prompt: "do it" })
      yield* next((e): e is WatchEvent => e._tag === "Session" && e.session.id === id && e.session.status === "working")
      const terminal = (yield* herdr.terminalOf(id))!
      yield* Effect.repeat(herdr.finishTurn(terminal.id), { times: 5 })
      const held = yield* herdr.hold("see", terminal.id)
      const five = yield* c["Session.Seen"]({ id, turn: 5 }).pipe(Effect.forkScoped)
      yield* held.reached
      const six = yield* c["Session.Seen"]({ id, turn: 6 }).pipe(Effect.forkScoped)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      yield* held.release()
      yield* Fiber.join(five)
      yield* Fiber.join(six)
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { turn: 6, seen: 6 })
    }),
  )

  test(
    "Watch is the user's: a main agent is refused",
    Effect.gen(function* () {
      const { coordinator } = yield* withMain
      const refused = yield* Effect.flip(Stream.runDrain(coordinator.Watch(undefined)))
      assert.strictEqual(refused._tag, "Forbidden")
    }),
  )

  test(
    "a client that stops acknowledging falls behind, and the stream fails with WatchLagged instead of growing",
    Effect.gen(function* () {
      const { repo, project } = yield* withMain
      const bus = yield* Bus
      const w = yield* wire
      yield* w.send({ jsonrpc: "2.0", id: 1, method: "Watch", params: null, headers: Object.entries(cliHeaders(repo)) })
      const first = yield* w.recv
      assert.strictEqual((first["result"] as Array<WatchEvent>)[0]!._tag, "Snapshot")
      for (let i = 0; i < Server.WATCH_BACKLOG + 500; i++)
        yield* bus.observe({ type: "live.project", projectId: project })
      const ack = { jsonrpc: "2.0", method: "@effect/rpc/Ack", params: { requestId: 1 } }
      for (;;) {
        yield* w.send(ack)
        const line = yield* w.recv
        if (line["chunk"] === true) continue
        assert.include(JSON.stringify(line["error"]), "WatchLagged")
        break
      }
    }),
  )

  test(
    "Ping says Watch and the project contracts (Harnesses.List, activity, Session.Seen) are there",
    Effect.gen(function* () {
      const capabilities = (yield* (yield* client).Ping()).capabilities
      assert.strictEqual(capabilities?.["watch"], true)
      assert.strictEqual(capabilities?.["projects"], true)
      assert.strictEqual(capabilities?.["harnesses"], true)
    }),
  )
})
