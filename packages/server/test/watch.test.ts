import fs from "node:fs/promises"
import http from "node:http"

import { assert, describe, it } from "@effect/vitest"
import { cliHeaders, connect } from "@vibest/client/client"
import { Bus, ProjectChanged, SessionChanged } from "@vibest/core/bus"
import { Db } from "@vibest/core/database/db"
import { Project } from "@vibest/core/project"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { EdgeDirected, type WatchEvent } from "@vibest/protocol/schemas"
import { Layout } from "@vibest/schema/layout"
import * as Listing from "@vibest/server/listing"
import * as Server from "@vibest/server/server"
import { WATCH_BACKLOG, WatchFeed } from "@vibest/server/watch-feed"
import {
  authed,
  FakeGit,
  FakeRuntime,
  makeRepository,
  projectOf,
  tempDirectory,
  testLayer,
  until,
  type TestServices,
} from "@vibest/testkit/fakes"
import * as Platform from "@vibest/testkit/platform"
import { Effect, Fiber, Layer, Option, Predicate, Queue, type Scope, Stream } from "effect"

const served = Server.layer.pipe(
  Layer.provide(Layer.unwrap(Effect.map(Layout, (layout) => Platform.httpServer(layout.socket)))),
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

  const started = yield* db.session.startRoot(
    project,
    "pi",
    false,
    { runtime: "herdr", target: { id: "w1:p8" } },
    { agent: "coordinator", projectDirectory: repo },
  )

  const entryClient = authed(yield* client, sessionHeaders({ sessionId: started.sessionId, projectId: project }))

  return { repo, project, entryId: started.sessionId, entryClient }
})

const watching = (repo: string) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<WatchEvent>()
    const c = authed(yield* client, cliHeaders(repo))
    yield* c["server.watch"]["watch.subscribe"]({}).pipe(
      Effect.flatMap((stream) => stream.pipe(Stream.runForEach((event) => Queue.offer(events, event)))),
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
          activity: "idle",
          repositories: [{ path: repo, identity: null }],
        },
      ])
      assert.deepStrictEqual(
        snapshot.sessions.map((s) => [s.id, s.agent, s.parentId]),
        [[entryId, "coordinator", null]],
      )

      const { id } = yield* entryClient["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      const spawned = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === id && e.session.executionState === "open",
      )

      assert.strictEqual(spawned.session.parentId, entryId)
      assert.strictEqual(spawned.session.projectId, project)
      assert.strictEqual(spawned.session.task, "do it")

      const other = yield* makeRepository
      const opened = yield* authed(yield* client, cliHeaders(other))["server.project"]["project.open"]({ payload: {} })

      const seen = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Project" }> =>
          Predicate.isTagged(e, "Project") && e.project.directory === other,
      )

      assert.deepStrictEqual(seen.project, {
        id: opened.projectId,
        directory: other,
        activity: "idle",
        repositories: [{ path: other, identity: null }],
      })

      yield* c["server.session"]["session.archive"]({ params: { id }, payload: {} })
      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "SessionEnded" }> =>
          Predicate.isTagged(e, "SessionEnded") && e.id === id && e.projectId === project,
      )
    }),
  )

  test(
    "an exited-but-unarchived session stays in Watch with exitedAt set until it is archived",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const { repo, project, entryClient } = yield* withEntry
      const { next, c } = yield* watching(repo)
      yield* next(isSnapshot)

      const { id } = yield* entryClient["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === id && e.session.startedAt !== null,
      )

      yield* db.session.endProcess(id, "exited")

      const exited = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === id && e.session.exitedAt !== null,
      )

      assert.isNotNull(exited.session.exitedAt)

      const snapshotAfterExit = yield* (yield* watching(repo)).next(isSnapshot)
      assert.isTrue(snapshotAfterExit.sessions.some((s) => s.id === id && s.exitedAt !== null))

      yield* c["server.session"]["session.archive"]({ params: { id }, payload: {} })
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

      const spawn = yield* entryClient["server.session"]
        ["session.spawn"]({
          payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "race" },
        })
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

      const { id } = yield* entryClient["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

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
      yield* herdr.countFinished(terminal["id"]!)
      yield* next((e): e is WatchEvent => isSession("done", 1)(e))
      yield* next((e): e is WatchEvent => isProject("done")(e))

      yield* c["server.session"]["session.seen"]({ params: { id }, payload: { finished: 2 } })
      yield* c["server.session"]["session.seen"]({ params: { id }, payload: { finished: 0 } })
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { finished: 1, seen: 0 })
      yield* c["server.session"]["session.seen"]({ params: { id }, payload: { finished: 1 } })
      yield* next((e): e is WatchEvent => isSession("idle", 1)(e))
      yield* next((e): e is WatchEvent => isProject("idle")(e))
      assert.deepStrictEqual(yield* herdr.runtime.seen!(terminal), { finished: 1, seen: 1 })
      assert.strictEqual(
        (yield* Effect.flip(
          entryClient["server.session"]["session.seen"]({ params: { id }, payload: { finished: 1 } }),
        ))._tag,
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

      const { id } = yield* entryClient["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* next(
        (e): e is WatchEvent =>
          Predicate.isTagged(e, "Session") && e.session.id === id && e.session.status === "working",
      )
      const terminal = (yield* herdr.terminalOf(id))!
      yield* Effect.repeat(herdr.countFinished(terminal["id"]!), { times: 5 })
      const held = yield* herdr.hold("see", terminal["id"]!)

      const five = yield* c["server.session"]
        ["session.seen"]({ params: { id }, payload: { finished: 5 } })
        .pipe(Effect.forkScoped)

      yield* held.reached

      const six = yield* c["server.session"]
        ["session.seen"]({ params: { id }, payload: { finished: 6 } })
        .pipe(Effect.forkScoped)

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
      yield* bus.publish(ProjectChanged, { projectId: project })
      const ended = yield* Effect.flip(Stream.runDrain(before))
      assert.strictEqual(ended._tag, "WatchLagged")
      failing = false
      const after = yield* feed.subscribe
      const next = yield* Effect.forkScoped(Stream.runHead(after))
      yield* bus.publish(ProjectChanged, { projectId: project })
      const event = yield* Fiber.join(next)
      assert.strictEqual(Option.isSome(event) && event.value._tag, "Project")
    }).pipe(Effect.provide(WatchFeed.layer.pipe(Layer.provide(Listing.layer)))),
  )

  test(
    "Watch is the user's: an entry session is refused",
    Effect.gen(function* () {
      const { entryClient } = yield* withEntry

      const refused = yield* Effect.flip(
        entryClient["server.watch"]["watch.subscribe"]({}).pipe(Effect.flatMap(Stream.runDrain)),
      )

      assert.strictEqual(refused._tag, "Forbidden")
    }),
  )

  test(
    "a client that stops reading falls behind, and the stream fails with WatchLagged instead of growing",
    Effect.gen(function* () {
      const { repo, project, entryId } = yield* withEntry
      const layout = yield* Layout
      const db = yield* Db.Service
      const bus = yield* Bus.Service

      const res = yield* Effect.acquireRelease(
        Effect.callback<http.IncomingMessage>((resume) => {
          const req = http.request(
            {
              socketPath: layout.socket,
              path: "/api/watch",
              method: "GET",
              headers: cliHeaders(repo),
            },
            (response) => {
              response.once("data", (chunk: Buffer) => {
                response.pause()
                assert.include(chunk.toString("utf8"), "Snapshot")
                resume(Effect.succeed(response))
              })
            },
          )

          req.end()
        }),
        (response) => Effect.sync(() => response.destroy()),
      )

      const read = db.session.sessionIdentity

      const ids = Array.from(
        { length: WATCH_BACKLOG + 500 },
        (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
      )

      const idSet = new Set(ids)

      Object.assign(db.session, {
        sessionIdentity: (id: string) => (idSet.has(id) ? Effect.succeed({ projectId: project }) : read(id)),
      })

      for (const id of ids) yield* bus.publish(SessionChanged, { sessionId: id })
      yield* bus.publish(SessionChanged, { sessionId: entryId })

      const rest = yield* Effect.callback<string>((resume) => {
        const chunks: Array<Buffer> = []
        res.on("data", (chunk: Buffer) => chunks.push(chunk))
        res.on("end", () => resume(Effect.succeed(Buffer.concat(chunks).toString("utf8"))))
        res.resume()
      }).pipe(Effect.timeout("20 seconds"), Effect.orDie)

      assert.include(rest, "WatchLagged")
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
      yield* bus.publish(ProjectChanged, { projectId: project })

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

      const openedSingle = yield* authed(yield* client, cliHeaders(single))["server.project"]["project.open"]({
        payload: {},
      })

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

      const openedMulti = yield* authed(yield* client, cliHeaders(parent))["server.project"]["project.open"]({
        payload: {},
      })

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
      yield* bus.publish(ProjectChanged, { projectId: openedMulti.projectId })

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

  test(
    "WatchSession.to reflects spawn edges in Snapshot and live Session deltas on Session.Link and Session.Unlink",
    Effect.gen(function* () {
      const { repo, entryId, entryClient } = yield* withEntry
      const cli = authed(yield* client, cliHeaders(repo))

      const a = yield* entryClient["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "a" },
      })

      const b = yield* entryClient["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "b" },
      })

      const { next } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      const snapA = snapshot.sessions.find((s) => s.id === a.id)
      const snapB = snapshot.sessions.find((s) => s.id === b.id)

      assert.deepStrictEqual(snapA?.to, [{ id: entryId }])
      assert.deepStrictEqual(snapB?.to, [{ id: entryId }])

      yield* cli["server.session"]["session.link"]({
        payload: { spec: EdgeDirected.make({ from: [{ id: a.id }], to: [{ id: b.id }] }) },
      })

      const linked = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === a.id && e.session.to.some((t) => t.id === b.id),
      )

      assert.deepStrictEqual(linked.session.to.map((t) => t.id).sort(), [b.id, entryId].sort())

      yield* cli["server.session"]["session.unlink"]({
        payload: { spec: EdgeDirected.make({ from: [{ id: a.id }], to: [{ id: b.id }] }) },
      })

      const unlinked = yield* next(
        (e): e is Extract<WatchEvent, { _tag: "Session" }> =>
          Predicate.isTagged(e, "Session") && e.session.id === a.id && !e.session.to.some((t) => t.id === b.id),
      )

      assert.deepStrictEqual(unlinked.session.to, [{ id: entryId }])
    }),
  )

  test(
    "exited unarchived sessions report null terminal and are excluded from Snapshot project.activity",
    Effect.gen(function* () {
      const db = yield* Db.Service
      const { repo, entryId, entryClient } = yield* withEntry

      const { id: childId } = yield* entryClient["server.session"]["session.spawn"]({
        payload: {
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "work",
        },
      })

      yield* until(
        db.session.getSession(childId),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.status === "working",
      )

      yield* db.session.endProcess(entryId, "exited")
      yield* db.session.endProcess(childId, "exited")

      const { next } = yield* watching(repo)
      const snapshot = yield* next(isSnapshot)
      const exitedChild = snapshot.sessions.find((s) => s.id === childId)
      assert.isDefined(exitedChild)
      assert.isNotNull(exitedChild?.exitedAt)
      assert.isNull(exitedChild?.terminal)

      const project = snapshot.projects.find((p) => p.id === exitedChild?.projectId)
      assert.strictEqual(project?.activity, "idle")
    }),
  )
})
