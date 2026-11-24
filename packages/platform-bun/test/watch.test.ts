import fs from "node:fs/promises"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Bus } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { Project } from "@vibest/core/project"
import { sessionHeaders } from "@vibest/protocol/protocol"
import type { WatchEvent } from "@vibest/protocol/rpc"
import { Layout } from "@vibest/schema/layout"
import * as Listing from "@vibest/server/listing"
import * as Server from "@vibest/server/server"
import { WATCH_BACKLOG, WatchFeed } from "@vibest/server/watch-feed"
import { Effect, Fiber, Layer, Option, Predicate, Queue, type Scope, Stream } from "effect"

import * as Platform from "#platform"

import {
  authed,
  FakeGit,
  FakeRuntime,
  makeRepository,
  projectOf,
  tempDirectory,
  testLayer,
  type TestServices,
  wire,
} from "./lib/fakes.ts"

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.socketServer(layout.socket)))),
  Layer.provideMerge(Project.layer),
  Layer.provideMerge(testLayer({ sshHosts: { work: "Git.Internal.Example" } })),
)

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Project.Service | Scope.Scope>) =>
  it.effect(name, () => program.pipe(Effect.provide(served)))

const client = Effect.flatMap(Layout, (layout) => connect(layout.socket))

const withEntry = Effect.gen(function* () {
  const db = yield* Db.Service
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

const isSnapshot = (e: WatchEvent): e is Extract<WatchEvent, { _tag: "Snapshot" }> => Predicate.isTagged(e, "Snapshot")

describe("Watch", () => {
  test(
    "a Snapshot of projects and sessions, then each change as it commits: subagents name their entry session",
    Effect.gen(function* () {
      const { repo, project, entryId, entryClient } = yield* withEntry
      const { next, c } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      assert.deepStrictEqual(snapshot.projects, [
        {
          id: project,
          directory: repo,
          entrySessionId: entryId,
          activity: "idle",
          repositories: [{ path: repo, identity: null }],
        },
      ])
      assert.deepStrictEqual(
        snapshot.sessions.map((s) => [s.id, s.agent, s.parentId]),
        [[entryId, "coordinator", null]],
      )

      const { id } = yield* entryClient.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })

      const spawned = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === id && e.session.executionState === "open",
      )

      assert.strictEqual(spawned.session.parentId, entryId)
      assert.strictEqual(spawned.session.projectId, project)
      assert.strictEqual(spawned.session.task, "do it")

      const other = yield* makeRepository
      const opened = yield* authed(yield* client, cliHeaders(other))["Project.Open"]({})

      const seen = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") && e.project.directory === other,
      )

      assert.deepStrictEqual(seen.project, {
        id: opened.projectId,
        directory: other,
        entrySessionId: null,
        activity: "idle",
        repositories: [{ path: other, identity: null }],
      })

      yield* c.Archive({ id })
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "SessionEnded" }> =>
          Predicate.isTagged(e, "SessionEnded") && e.id === id && e.projectId === project,
      )
    }),
  )

  test(
    "a project move sends the sessions it moved again, with their new directories",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const { repo, project, entryId } = yield* withEntry
      const { next } = yield* watching(repo)
      yield* next(isSnapshot)
      const moved = `${yield* tempDirectory("vibest-moved-")}/repo`
      yield* Effect.promise(() => fs.cp(repo, moved, { recursive: true }))
      yield* db.project.moveProject(project, moved, [])
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === entryId && e.session.worktree === moved,
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
        yield* next(
          (e): e is Extract<WatchEvent, { _tag: "Session" }> => Predicate.isTagged(e, "Session") && e.session.id === id,
        )
    }),
  )

  test(
    "an execution that ends unwatched is done, for the session and its project, until Session.Seen raises the mark to it",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const db = yield* Db.Service
      const { repo, project, entryClient } = yield* withEntry
      const { next, c } = yield* watching(repo)
      yield* next(isSnapshot)
      const { id } = yield* entryClient.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" })

      const isSession = (status: string, finished: number) => (e: WatchEvent) =>
        Predicate.isTagged(e, "Session") &&
        e.session.id === id &&
        e.session.status === status &&
        e.session.finished === finished

      yield* next((e): e is WatchEvent => isSession("working", 0)(e))
      const terminal = (yield* herdr.terminalOf(id))!
      yield* herdr.endExecution(id)
      yield* db.session.setStatus(id, "idle")

      const isProject = (activity: string) => (e: WatchEvent) =>
        Predicate.isTagged(e, "Project") && e.project.id === project && e.project.activity === activity

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
      yield* next(
        (e): e is WatchEvent =>
          Predicate.isTagged(e, "Session") && e.session.id === id && e.session.status === "working",
      )
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
    "two watchers share one change: its session row is read once",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const { repo, entryId } = yield* withEntry
      const first = yield* watching(repo)
      const second = yield* watching(repo)
      yield* first.next(isSnapshot)
      yield* second.next(isSnapshot)
      const briefs = db.session.sessionBriefs
      let reads = 0
      Object.assign(db.session, {
        sessionBriefs: (ids: Parameters<typeof briefs>[0]) => {
          reads++

          return briefs(ids)
        },
      })

      const inStatus = (status: string) => (e: WatchEvent) =>
        Predicate.isTagged(e, "Session") && e.session.id === entryId && e.session.status === status

      yield* db.session.setStatus(entryId, "working")
      yield* first.next((e): e is WatchEvent => inStatus("working")(e))
      yield* second.next((e): e is WatchEvent => inStatus("working")(e))
      reads = 0
      yield* db.session.setStatus(entryId, "idle")
      yield* first.next((e): e is WatchEvent => inStatus("idle")(e))
      yield* second.next((e): e is WatchEvent => inStatus("idle")(e))
      assert.strictEqual(reads, 1)
    }),
  )

  test(
    "a change that cannot be read ends the watchers it was for with an error; the feed serves later watchers",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const bus = yield* Bus.Service
      const { project } = yield* withEntry
      const feed = yield* WatchFeed.Service
      const before = yield* feed.subscribe
      const read = db.project.watchProjects
      let failing = true
      Object.assign(db.project, {
        watchProjects: (id?: string) => (failing ? Effect.die("unreadable") : read(id)),
      })
      yield* bus.observe({ type: "project.changed", projectId: project })
      const ended = yield* Effect.flip(Stream.runDrain(before))
      assert.strictEqual(ended._tag, "WatchLagged")
      failing = false
      const after = yield* feed.subscribe
      const next = yield* Effect.forkScoped(Stream.runHead(after))
      yield* bus.observe({ type: "project.changed", projectId: project })
      const event = yield* Fiber.join(next)
      assert.strictEqual(Option.isSome(event) && event.value._tag, "Project")
    }).pipe(Effect.provide(WatchFeed.layer.pipe(Layer.provide(Listing.layer)))),
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
      const { repo, project, entryId } = yield* withEntry
      const db = yield* Db.Service
      const bus = yield* Bus.Service
      const w = yield* wire
      yield* w.send({ jsonrpc: "2.0", id: 1, method: "Watch", params: null, headers: Object.entries(cliHeaders(repo)) })
      const first = yield* w.recv
      assert.strictEqual((first["result"] as Array<WatchEvent>)[0]!._tag, "Snapshot")

      const read = db.session.sessionIdentity
      const ids = Array.from({ length: WATCH_BACKLOG + 500 }, (_, i) => `ended-${i}`)

      Object.assign(db.session, {
        sessionIdentity: (id: string) => (id.startsWith("ended-") ? Effect.succeed({ projectId: project }) : read(id)),
      })

      for (const id of ids) yield* bus.observe({ type: "session.changed", sessionId: id })
      yield* bus.observe({ type: "session.changed", sessionId: entryId })
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
    "session.changed ticks reuse cached project repositories without re-probing git, while project.changed invalidates the cache",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const bus = yield* Bus.Service
      const fakeGit = yield* FakeGit
      const { repo, project, entryId } = yield* withEntry
      yield* fakeGit.update(repo, { origin: "git@github.com:Org/Cached.git" })

      const { next } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)

      assert.deepStrictEqual(snapshot.projects, [
        {
          id: project,
          directory: repo,
          entrySessionId: entryId,
          activity: "idle",
          repositories: [{ path: repo, identity: "github.com/Org/Cached" }],
        },
      ])

      const readRemote = fakeGit.git.remoteUrl
      let remoteReads = 0

      Object.assign(fakeGit.git, {
        remoteUrl: (dir: string, order?: "ranked" | "project") => {
          remoteReads++

          return readRemote(dir, order)
        },
      })

      yield* db.session.setStatus(entryId, "working")
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") && e.project.id === project && e.project.activity === "working",
      )
      yield* db.session.setStatus(entryId, "idle")
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") && e.project.id === project && e.project.activity === "idle",
      )
      assert.strictEqual(remoteReads, 0)

      yield* fakeGit.update(repo, { origin: "git@github.com:Org/Updated.git" })
      yield* bus.observe({ type: "project.changed", projectId: project })

      const refreshed = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") &&
          e.project.id === project &&
          e.project.repositories[0]?.identity === "github.com/Org/Updated",
      )

      assert.strictEqual(remoteReads, 1)
      assert.deepStrictEqual(refreshed.project.repositories, [{ path: repo, identity: "github.com/Org/Updated" }])
    }),
  )

  test(
    "Snapshot and Project events include normalized repository identities for single-repo, multi-repo and updated projects",
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const fakeGit = yield* FakeGit
      const single = yield* makeRepository
      yield* fakeGit.update(single, { origin: "git@github.com:Org/App.git" })
      const openedSingle = yield* authed(yield* client, cliHeaders(single))["Project.Open"]({})

      const parent = yield* tempDirectory("vibest-multi-")
      const repoA = `${parent}/a-origin`
      const repoB = `${parent}/b-alias`
      const repoC = `${parent}/c-local`
      yield* Effect.promise(() => fs.mkdir(repoA))
      yield* Effect.promise(() => fs.mkdir(repoB))
      yield* Effect.promise(() => fs.mkdir(repoC))
      yield* fakeGit.repository(repoA, { origin: "https://GitHub.com/Org/Web.git" })
      yield* fakeGit.repository(repoB, { origin: "work:team/service.git" })
      yield* fakeGit.repository(repoC)

      const { next } = yield* watching(single)
      const snapshot = yield* next(isSnapshot)
      const singleRow = snapshot.projects.find((p) => p.id === openedSingle.projectId)

      assert.deepStrictEqual(singleRow?.repositories, [{ path: single, identity: "github.com/Org/App" }])

      const openedMulti = yield* authed(yield* client, cliHeaders(parent))["Project.Open"]({})

      const multiEvent = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") && e.project.id === openedMulti.projectId,
      )

      const expectedMulti = [
        { path: repoA, identity: "github.com/Org/Web" },
        { path: repoB, identity: "git.internal.example/team/service" },
        { path: repoC, identity: null },
      ]

      assert.deepStrictEqual(multiEvent.project.repositories, expectedMulti)

      const snapshotAfter = yield* (yield* watching(parent)).next(isSnapshot)
      const multiRow = snapshotAfter.projects.find((p) => p.id === openedMulti.projectId)

      assert.deepStrictEqual(multiRow?.repositories, expectedMulti)

      yield* fakeGit.update(repoC, { origin: "git@gitlab.com:team/newly-added.git" })
      yield* bus.observe({ type: "project.changed", projectId: openedMulti.projectId })

      const updated = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") &&
          e.project.id === openedMulti.projectId &&
          e.project.repositories.some((r) => r.path === repoC && r.identity === "gitlab.com/team/newly-added"),
      )

      assert.deepStrictEqual(updated.project.repositories, [
        { path: repoA, identity: "github.com/Org/Web" },
        { path: repoB, identity: "git.internal.example/team/service" },
        { path: repoC, identity: "gitlab.com/team/newly-added" },
      ])
    }),
  )
})
