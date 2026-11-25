import path from "node:path"

import { assert, describe } from "@effect/vitest"
import { SessionLaunch } from "@vibest/core/session/entry"
import { Placement } from "@vibest/core/session/placement"
import { SessionStore } from "@vibest/core/session/store"
import { projectOf } from "@vibest/testkit/directory"
import { FakeRuntime } from "@vibest/testkit/fake-runtime"
import { makeRepository } from "@vibest/testkit/session"
import { test } from "@vibest/testkit/sessions-helpers"
import { Effect } from "effect"

const insertTopLevel = (projectId: string, name: string, cwd: string) =>
  Effect.gen(function* () {
    const sessionStore = yield* SessionStore.Service
    const id = yield* sessionStore.newSessionId

    yield* sessionStore.insertSession(
      {
        id,
        agent: "general",
        harnessId: "pi",
        harnessSessionId: null,
        runtime: "herdr",
        terminal: null,
        name,
        provider: null,
        model: null,
        status: "unknown",
        startedAt: null,
        exitedAt: null,
        executionState: "none",
        executionPromptedAt: 0,
        createdAt: Date.now(),
        lastActive: Date.now(),
      },
      projectId,
      { cwd },
    )

    return (yield* sessionStore.getSession(id))!
  })

describe.concurrent("Placement project near-terminal", () => {
  test(
    "reuses the project's last terminal for top-level sessions while live and after exit, and isolates projects",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const placement = yield* Placement.Service
      const fake = yield* FakeRuntime
      const repoA = yield* makeRepository
      const repoB = yield* makeRepository
      const projectA = yield* projectOf(repoA)
      const projectB = yield* projectOf(repoB)

      const s1 = yield* insertTopLevel(projectA, "first", repoA)

      const t1 = yield* placement.openTerminal(fake.runtime, undefined, s1, {
        project: repoA,
        cwd: repoA,
        launch: () => ({ argv: [], env: {} }),
      })

      const opensAfter1 = yield* fake.callsTo("open")
      assert.isUndefined(opensAfter1.at(-1)?.near)
      assert.strictEqual(opensAfter1.at(-1)?.label, "first")

      const s2 = yield* insertTopLevel(projectA, "second", repoA)
      yield* placement.openTerminal(fake.runtime, undefined, s2, {
        project: repoA,
        cwd: repoA,
        launch: () => ({ argv: [], env: {} }),
      })

      const opensAfter2 = yield* fake.callsTo("open")
      assert.strictEqual(opensAfter2.at(-1)?.near, t1.id)
      assert.isUndefined(opensAfter2.at(-1)?.parent)

      yield* sessionStore.endProcess(s1.id, "exited")
      yield* sessionStore.endProcess(s2.id, "exited")

      const s3 = yield* insertTopLevel(projectA, "third", repoA)
      yield* placement.openTerminal(fake.runtime, undefined, s3, {
        project: repoA,
        cwd: repoA,
        launch: () => ({ argv: [], env: {} }),
      })

      const opensAfter3 = yield* fake.callsTo("open")
      assert.isDefined(opensAfter3.at(-1)?.near)
      assert.notStrictEqual(opensAfter3.at(-1)?.near, "")

      const sB = yield* insertTopLevel(projectB, "other-project", repoB)
      yield* placement.openTerminal(fake.runtime, undefined, sB, {
        project: repoB,
        cwd: repoB,
        launch: () => ({ argv: [], env: {} }),
      })

      const opensAfterB = yield* fake.callsTo("open")
      assert.isUndefined(opensAfterB.at(-1)?.near)
    }),
  )

  test(
    "explicit target wins over lastProjectTerminal",
    Effect.gen(function* () {
      const placement = yield* Placement.Service
      const fake = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)

      const s1 = yield* insertTopLevel(projectId, "first", repo)
      yield* placement.openTerminal(fake.runtime, undefined, s1, {
        project: repo,
        cwd: repo,
        launch: () => ({ argv: [], env: {} }),
      })

      const s2 = yield* insertTopLevel(projectId, "targeted", repo)
      yield* placement.openTerminal(fake.runtime, "other-session", s2, {
        project: repo,
        cwd: repo,
        launch: () => ({ argv: [], env: {} }),
      })

      const lastOpen = (yield* fake.callsTo("open")).at(-1)
      assert.isUndefined(lastOpen?.near)
      assert.strictEqual(lastOpen?.label, "targeted")
      assert.strictEqual(lastOpen?.target, "other-session")
    }),
  )

  test(
    "lastProjectTerminal prefers live over ended and excludes remote peer sessions",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)

      const liveId = yield* sessionStore.newSessionId
      yield* sessionStore.insertSession(
        {
          id: liveId,
          agent: "general",
          harnessId: "pi",
          harnessSessionId: null,
          runtime: "rex",
          terminal: { session: "session:live", block: "block:1" },
          name: "live",
          provider: null,
          model: null,
          status: "unknown",
          startedAt: 100,
          exitedAt: null,
          executionState: "none",
          executionPromptedAt: 0,
          createdAt: 100,
          lastActive: 100,
        },
        projectId,
        { cwd: repo },
      )

      const endedId = yield* sessionStore.newSessionId
      yield* sessionStore.insertSession(
        {
          id: endedId,
          agent: "general",
          harnessId: "pi",
          harnessSessionId: null,
          runtime: "rex",
          terminal: { session: "session:ended", block: "block:2" },
          name: "ended",
          provider: null,
          model: null,
          status: "unknown",
          startedAt: 200,
          exitedAt: 250,
          executionState: "none",
          executionPromptedAt: 0,
          createdAt: 200,
          lastActive: 250,
        },
        projectId,
        { cwd: repo },
      )

      const remoteId = yield* sessionStore.newSessionId
      yield* sessionStore.insertSession(
        {
          id: remoteId,
          agent: "general",
          harnessId: "pi",
          harnessSessionId: null,
          runtime: "rex",
          terminal: { session: "session:remote", block: "block:3" },
          name: "remote",
          provider: null,
          model: null,
          status: "unknown",
          startedAt: 300,
          exitedAt: null,
          executionState: "none",
          executionPromptedAt: 0,
          createdAt: 300,
          lastActive: 300,
        },
        projectId,
        { cwd: repo, origin: { remote: "remote-1", project: "remote-proj" } },
      )

      assert.deepStrictEqual(yield* sessionStore.lastProjectTerminal(projectId, "rex"), {
        session: "session:live",
        block: "block:1",
      })

      yield* sessionStore.endProcess(liveId, "exited")

      assert.deepStrictEqual(yield* sessionStore.lastProjectTerminal(projectId, "rex"), {
        session: "session:ended",
        block: "block:2",
      })
    }),
  )

  test(
    "SessionLaunch.launch reuses lastProjectTerminal when target is omitted and respects explicit target",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const entry = yield* SessionLaunch.Service
      const fake = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)

      const first = yield* entry.launch({
        projectId,
        root: repo,
        at: { id: "local" },
        sessionId: undefined,
        fresh: false,
        harness: "pi",
        provider: undefined,
        model: undefined,
        focus: false,
        runtime: "herdr",
        agent: { id: "coordinator", named: false },
      })

      const entryRow = (yield* sessionStore.latestRoot(projectId))!
      assert.strictEqual(entryRow.name, `Vibest/${path.basename(repo)}`)
      assert.strictEqual((yield* fake.callsTo("open")).at(-1)?.label, entryRow.name)
      yield* sessionStore.endProcess(entryRow.id, "exited")

      yield* entry.launch({
        projectId,
        root: repo,
        at: { id: "local" },
        sessionId: undefined,
        fresh: false,
        harness: "pi",
        provider: undefined,
        model: undefined,
        focus: false,
        runtime: "herdr",
        agent: { id: "coordinator", named: false },
      })

      const secondOpen = (yield* fake.callsTo("open")).at(-1)
      assert.strictEqual(secondOpen?.near, first.terminal["id"])
      assert.isUndefined(secondOpen?.parent)

      const secondEntryRow = (yield* sessionStore.latestRoot(projectId))!
      yield* sessionStore.endProcess(secondEntryRow.id, "exited")

      yield* entry.launch({
        projectId,
        root: repo,
        at: { id: "local", target: "explicit-session" },
        sessionId: undefined,
        fresh: false,
        harness: "pi",
        provider: undefined,
        model: undefined,
        focus: false,
        runtime: "herdr",
        agent: { id: "coordinator", named: false },
      })

      const thirdOpen = (yield* fake.callsTo("open")).at(-1)
      assert.isUndefined(thirdOpen?.near)
      assert.isUndefined(thirdOpen?.parent)
      assert.strictEqual(thirdOpen?.target, "explicit-session")
    }),
  )

  test(
    "child session passes creator terminal as parent and near, while top-level sessions pass no parent",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const placement = yield* Placement.Service
      const fake = yield* FakeRuntime
      const repo = yield* makeRepository
      const projectId = yield* projectOf(repo)

      const creator = yield* insertTopLevel(projectId, "creator", repo)

      const creatorTerminal = yield* placement.openTerminal(fake.runtime, undefined, creator, {
        project: repo,
        cwd: repo,
        launch: () => ({ argv: [], env: {} }),
      })

      const childId = yield* sessionStore.newSessionId
      yield* sessionStore.insertSession(
        {
          id: childId,
          agent: "general",
          harnessId: "pi",
          harnessSessionId: null,
          runtime: "herdr",
          terminal: null,
          name: "child",
          provider: null,
          model: null,
          status: "unknown",
          startedAt: null,
          exitedAt: null,
          executionState: "none",
          executionPromptedAt: 0,
          createdAt: Date.now(),
          lastActive: Date.now(),
        },
        projectId,
        { cwd: repo, parentSessionId: creator.id },
      )
      const child = (yield* sessionStore.getSession(childId))!

      yield* placement.openTerminal(fake.runtime, undefined, child, {
        project: repo,
        cwd: repo,
        launch: () => ({ argv: [], env: {} }),
      })

      const childOpen = (yield* fake.callsTo("open")).at(-1)
      assert.strictEqual(childOpen?.parent, creatorTerminal.id)
      assert.strictEqual(childOpen?.near, creatorTerminal.id)
    }),
  )
})
