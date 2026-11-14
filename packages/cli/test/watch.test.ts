import fs from "node:fs/promises"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { Project } from "@vibest/core/project"
import { sessionHeaders } from "@vibest/protocol/protocol"
import type { WatchEvent } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import { WATCH_BACKLOG } from "@vibest/server/handlers/session"
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
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer()),
)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project.Service | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)))

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

const withEntry = Effect.gen(function* () {
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const project = yield* projectOf(repo)
  yield* herdr.addPane("w1:p8", "ws", repo)
  yield* herdr.seedAgent("w1:p8")
  const started = yield* db.session.startEntry(
    project,
    "pi",
    false,
    { runtime: "herdr", address: { machine: "local", id: "w1:p8" } },
    { agent: "coordinator", projectDirectory: repo },
  )
  const entryClient = authed(yield* client, sessionHeaders({ sessionId: started.sessionId, projectId: project }))
  return { repo, project, entryId: started.sessionId, entryClient }
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
    "a Snapshot of projects and sessions, then each change as it commits: subagents name their entry session",
    Effect.gen(function* () {
      const { repo, project, entryId, entryClient } = yield* withEntry
      const { next, c } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      assert.deepStrictEqual(snapshot.projects, [
        { id: project, directory: repo, entrySessionId: entryId, activity: "idle" },
      ])
      assert.deepStrictEqual(
        snapshot.sessions.map((s) => [s.id, s.agent, s.parentId]),
        [[entryId, "coordinator", null]],
      )

      const { id } = yield* entryClient.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      const spawned = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          e._tag === "Session" && e.session.id === id && e.session.executionState === "open",
      )
      assert.strictEqual(spawned.session.parentId, entryId)
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
      const { repo, project, entryId } = yield* withEntry
      const { next } = yield* watching(repo)
      yield* next(isSnapshot)
      const moved = `${yield* tempDirectory("vibest-moved-")}/repo`
      yield* Effect.promise(() => fs.cp(repo, moved, { recursive: true }))
      yield* db.project.moveProject(project, moved, [])
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          e._tag === "Session" && e.session.id === entryId && e.session.worktree === moved,
      )
    }),
  )

  test(
    "a session started while Watch reads its Snapshot is in the Snapshot or arrives after it",
    Effect.gen(function* () {
      const { repo, entryClient } = yield* withEntry
      const spawn = yield* entryClient
        .Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "race" })
        .pipe(Effect.forkScoped)
      const { next } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      const { id } = yield* Fiber.join(spawn)
      if (!snapshot.sessions.some((s) => s.id === id))
        yield* next((e): e is Extract<WatchEvent, { _tag: "Session" }> => e._tag === "Session" && e.session.id === id)
    }),
  )

  test(
    "an execution that ends unwatched is done, for the session and its project, until Session.Seen raises the mark to it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db
      const { repo, project, entryClient } = yield* withEntry
      const { next, c } = yield* watching(repo)
      yield* next(isSnapshot)
      const { id } = yield* entryClient.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      const isSession = (status: string, finished: number) => (e: WatchEvent) =>
        e._tag === "Session" && e.session.id === id && e.session.status === status && e.session.finished === finished
      yield* next((e): e is WatchEvent => isSession("working", 0)(e))
      const terminal = (yield* herdr.terminalOf(id))!
      yield* herdr.endExecution(id)
      yield* db.session.setStatus(id, "idle")
      const isProject = (activity: string) => (e: WatchEvent) =>
        e._tag === "Project" && e.project.id === project && e.project.activity === activity
      yield* next((e): e is WatchEvent => isSession("idle", 0)(e))
      yield* herdr.countFinished(terminal.id)
      yield* next((e): e is WatchEvent => isSession("done", 1)(e))
      yield* next((e): e is WatchEvent => isProject("done")(e))

      yield* c["Session.Seen"]({ id, finished: 2 })
      yield* c["Session.Seen"]({ id, finished: 0 })
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { finished: 1, seen: 0 })
      yield* c["Session.Seen"]({ id, finished: 1 })
      yield* next((e): e is WatchEvent => isSession("idle", 1)(e))
      yield* next((e): e is WatchEvent => isProject("idle")(e))
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { finished: 1, seen: 1 })
      assert.strictEqual(
        (yield* Effect.flip(entryClient["Session.Seen"]({ id, finished: 1 })))._tag,
        "Forbidden",
        "only the user marks what they saw",
      )
    }),
  )

  test(
    "overlapping Session.Seen calls on one terminal run one after another, so the mark ends at the higher finished count",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const { repo, entryClient } = yield* withEntry
      const { next, c } = yield* watching(repo)
      yield* next(isSnapshot)
      const { id } = yield* entryClient.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })
      yield* next((e): e is WatchEvent => e._tag === "Session" && e.session.id === id && e.session.status === "working")
      const terminal = (yield* herdr.terminalOf(id))!
      yield* Effect.repeat(herdr.countFinished(terminal.id), { times: 5 })
      const held = yield* herdr.hold("see", terminal.id)
      const five = yield* c["Session.Seen"]({ id, finished: 5 }).pipe(Effect.forkScoped)
      yield* held.reached
      const six = yield* c["Session.Seen"]({ id, finished: 6 }).pipe(Effect.forkScoped)
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 200)))
      yield* held.release()
      yield* Fiber.join(five)
      yield* Fiber.join(six)
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { finished: 6, seen: 6 })
    }),
  )

  test(
    "Watch is the user's: an entry session is refused",
    Effect.gen(function* () {
      const { entryClient } = yield* withEntry
      const refused = yield* Effect.flip(Stream.runDrain(entryClient.Watch(undefined)))
      assert.strictEqual(refused._tag, "Forbidden")
    }),
  )

  test(
    "a client that stops acknowledging falls behind, and the stream fails with WatchLagged instead of growing",
    Effect.gen(function* () {
      const { repo, project } = yield* withEntry
      const bus = yield* Bus
      const w = yield* wire
      yield* w.send({ jsonrpc: "2.0", id: 1, method: "Watch", params: null, headers: Object.entries(cliHeaders(repo)) })
      const first = yield* w.recv
      assert.strictEqual((first["result"] as Array<WatchEvent>)[0]!._tag, "Snapshot")
      for (let i = 0; i < WATCH_BACKLOG + 500; i++) yield* bus.observe({ type: "project.changed", projectId: project })
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
})
