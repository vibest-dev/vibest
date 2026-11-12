import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { peerAdmitPause, Sessions } from "@vibest/core/sessions"
import { Deferred, Effect, Fiber, FileSystem, HashMap, Path } from "effect"
import { TestClock } from "effect/testing"

import { FakeProcesses } from "./lib/fake-processes.ts"
import { FakeRuntime } from "./lib/fake-runtime.ts"
import { atMostEntryTracked, systemPromptFile, until, untilVirtual, writeEnd } from "./lib/observe.ts"
import { callerPlugin, makeRepository } from "./lib/session.ts"
import { spawnInput, spawnWorking, idleSession, sessionWorktree, test } from "./lib/sessions-helpers.ts"

describe.concurrent("Sessions", () => {
  test(
    "run --peer shares the worktree; archiving keeps it while another live session works in it, and the last one removes it",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const peer = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(peer.id)
      const peerPane = (yield* herdr.agent(peer.id))!.terminal

      const { id } = yield* peer.sessions.spawn({ ...(yield* spawnInput(repo)), peer: peer.id })
      yield* until(peer.db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* peer.sessions.check(id)
      assert.lengthOf(yield* herdr.callsTo("open"), 2)
      const split = (yield* herdr.callsTo("open")).at(-1)!
      assert.strictEqual(split.near, peerPane)
      assert.strictEqual(split.cwd, worktree)
      assert.deepInclude(split.env, { VIBEST_SESSION_ID: id })
      const pane = (yield* herdr.agent(id))!.terminal
      assert.strictEqual(pane.split(":")[0], peerPane.split(":")[0])
      const got = yield* peer.sessions.get(id)
      assert.deepInclude(got, { worktree })
      assert.notProperty(got.metadata, "peer")
      assert.strictEqual(yield* sessionWorktree(id), worktree)
      assert.match(path.basename(worktree), /^[0-9a-f]{4}$/)
      const rules = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(rules, `Your working directory is shared with session ${peer.id}`)

      const third = yield* peer.sessions.spawn({ ...(yield* spawnInput(repo)), peer: id })
      assert.strictEqual(yield* sessionWorktree(third.id), worktree)
      yield* until(peer.db.getSession(third.id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      assert.strictEqual((yield* peer.sessions.get(third.id)).worktree, worktree)
      assert.strictEqual((yield* herdr.callsTo("open"))[2]!.near, pane)
      assert.lengthOf(yield* herdr.callsTo("open"), 3)

      const ownerFirst = (yield* peer.sessions.remove(peer.id))!
      assert.deepInclude(ownerFirst, { processes: "exited", pane: "closed", worktree: "kept", path: worktree })
      assert.include(ownerFirst.reasons.join("\n"), id)
      assert.include(ownerFirst.reasons.join("\n"), third.id)
      assert.isTrue(yield* fs.exists(worktree))

      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* peer.sessions.check(id)
      const borrower = (yield* peer.sessions.remove(id))!
      assert.deepInclude(borrower, { processes: "exited", pane: "closed", worktree: "kept", path: worktree })
      assert.include(borrower.reasons.join("\n"), `session ${third.id} still works in it`)
      assert.isFalse(yield* fs.exists(yield* systemPromptFile(id)))
      assert.isTrue(yield* fs.exists(worktree))

      const ownerSecond = (yield* peer.sessions.remove(peer.id))!
      assert.deepInclude(ownerSecond, { worktree: "kept", path: worktree })
      assert.include(ownerSecond.reasons.join("\n"), third.id)
      assert.notInclude(ownerSecond.reasons.join("\n"), id)
      assert.isTrue(yield* fs.exists(worktree))

      yield* writeEnd(third.id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(third.id)
      yield* peer.sessions.check(third.id)
      const last = (yield* peer.sessions.remove(third.id))!
      assert.deepInclude(last, { worktree: "removed", path: worktree })
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )

  test(
    "a resume keeps the owner's git rules beside a --peer; only the --peer gets the peer rules",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* until(owner.db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      yield* writeEnd(id, "pi", { text: "status: completed" })
      yield* herdr.endExecution(id)
      yield* owner.sessions.check(id)
      for (const session of [owner.id, id]) {
        yield* herdr.updateAgent(session, (a) => ({ ...a, alive: false }))
        yield* owner.sessions.check(session)
      }
      yield* untilVirtual(owner.sessions.inMemory, atMostEntryTracked)
      for (const session of [owner.id, id]) {
        yield* owner.sessions.send(session, `again ${session}`)
        yield* until(herdr.callsTo("send"), (calls) => calls.some((c) => c.text === `again ${session}`))
      }
      assert.notInclude(yield* fs.readFileString(yield* systemPromptFile(owner.id)), "Your working directory is shared")
      const peerRules = yield* fs.readFileString(yield* systemPromptFile(id))
      assert.include(peerRules, `Your working directory is shared with session ${owner.id}`)
    }),
  )

  test(
    "run --peer refuses a missing, cross-project, archived or ineligible session before it creates a worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const sessions = yield* Sessions
      const db = yield* Db
      const unknown = yield* Effect.flip(
        sessions.spawn({ ...(yield* spawnInput(repo)), peer: "ffffffff-ffff-4fff-8fff-ffffffffffff" }),
      )
      assert.strictEqual(unknown._tag, "NoSuchSession")
      assert.include(
        unknown.message,
        "--peer ffffffff-ffff-4fff-8fff-ffffffffffff: no session ffffffff-ffff-4fff-8fff-ffffffffffff",
      )

      const { id, row } = yield* spawnWorking(repo)
      const created = () => herdr.callsTo("open").pipe(Effect.map((calls) => calls.length))
      const before = yield* created()
      const otherRepo = yield* makeRepository
      const cross = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(otherRepo)), peer: id }))
      assert.include(cross.message, "belongs to another project")
      const worktree = yield* sessionWorktree(id)
      yield* fs.rename(worktree, `${worktree}.away`)
      const gone = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(gone.message, "ineligible")
      assert.include(gone.message, "gone")
      yield* fs.rename(`${worktree}.away`, worktree)
      yield* db.updateSession(id, { metadata: { ...row.metadata, archived: true, removed: true } })
      const archived = yield* Effect.flip(sessions.spawn({ ...(yield* spawnInput(repo)), peer: id }))
      assert.include(archived.message, "it was archived")
      assert.strictEqual(yield* created(), before)
      assert.isUndefined(yield* db.getSession("ffffffff-ffff-4fff-8fff-ffffffffffff"))
    }),
  )

  test(
    "run --peer without --runtime uses the peer runtime, and an explicit other runtime is still refused",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const parent = yield* owner.db.startEntry(
        owner.row.projectId,
        "pi",
        false,
        {
          runtime: "hc",
          address: { machine: "local", id: "test/coord-hc" },
        },
        { agent: "coordinator" },
      )
      assert.strictEqual((yield* owner.db.entryOf(owner.row.projectId))?.runtime, "hc")
      const base = yield* spawnInput(repo)
      const followed = yield* owner.sessions.spawn({
        machine: base.machine,
        root: base.root,
        projectId: base.projectId,
        name: base.name,
        prompt: base.prompt,
        harness: base.harness,
        peer: owner.id,
        agent: base.agent,
        parentSessionId: parent.sessionId,
      })
      assert.strictEqual(followed.runtime, "herdr")
      assert.strictEqual(yield* owner.db.sessionDirectory(followed.id), yield* owner.db.sessionDirectory(owner.id))
      yield* until(owner.db.getSession(followed.id), (w) => !!w && w.startedAt !== null)
      const refused = yield* Effect.flip(
        owner.sessions.spawn({
          ...base,
          runtime: "hc",
          peer: owner.id,
          parentSessionId: parent.sessionId,
        }),
      )
      assert.strictEqual(refused._tag, "NoSuchSession")
      assert.include(refused.message, "ineligible: it runs in herdr on local, not hc on local")
    }),
    {
      plugins: [callerPlugin("hc", { env: ["HC_ID"], terminal: (env) => Effect.succeed(env.HC_ID) })],
    },
  )

  const started: Array<string> = []
  test(
    "agent.start runs before both run and run --peer start a session",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      started.length = 0
      const owner = yield* idleSession(repo)
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), prompt: "peer task", peer: owner.id })
      assert.deepStrictEqual(started, [`${repo}: do it`, `${repo}: peer task`])
      assert.strictEqual(owner.row.model, "fake-strong")
      assert.strictEqual((yield* owner.db.getSession(id))!.model, "fake-strong")
    }),
    {
      plugins: [
        {
          id: "seen",
          effect: (ctx) =>
            ctx.agent.hook("start.before", (e) =>
              Effect.sync(() => {
                started.push(`${e.project}: ${e.prompt}`)
                return { model: "fake-strong" }
              }),
            ),
        },
      ],
    },
  )

  const peersSharingDirectory = (ownerId: string) =>
    Effect.gen(function* () {
      const db = yield* Db
      const shared = yield* db.sessionDirectory(ownerId)
      return yield* Effect.filter(
        (yield* db.listSessions({ stopped: true })).filter((s) => s.id !== ownerId),
        (s) => db.sessionDirectory(s.id).pipe(Effect.map((d) => d === shared)),
      )
    })

  const parkAdmitBeforeInsert = Effect.gen(function* () {
    const reached = yield* Deferred.make<void>()
    const go = yield* Deferred.make<void>()
    peerAdmitPause.wait = Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(go)))
    return { reached: Deferred.await(reached), release: Deferred.succeed(go, undefined).pipe(Effect.asVoid) }
  })

  test(
    "owner archive cannot delete a clean worktree while run --peer is admitted",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const parked = yield* parkAdmitBeforeInsert
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.sync(() => {
        peerAdmitPause.wait = Effect.void
      }).pipe(
        Effect.andThen(
          Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore),
        ),
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id }))
        yield* parked.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parked.release
          yield* until(peersSharingDirectory(owner.id), (rows) => rows.length === 1)
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          const exists = yield* fs.exists(worktree)
          assert.fail(
            "archive listed no borrower then removed the tree after admit: worktree=" +
              archived.worktree +
              " exists=" +
              String(exists),
          )
        }
        assert.deepStrictEqual(yield* peersSharingDirectory(owner.id), [])
        assert.isUndefined(archiving.pollUnsafe())
        yield* parked.release
        yield* until(peersSharingDirectory(owner.id), (rows) => rows.length === 1)
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), (yield* peersSharingDirectory(owner.id))[0]!.id)
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    undefined,
    true,
  )

  test(
    "a borrower admitted before archive keeps the clean worktree while its launch is still in herdr",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const split = yield* herdr.hold("open")
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id }))
        yield* split.reached
        const admitted = yield* Fiber.join(spawning)
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        yield* until(
          Effect.sync(() => archiving.pollUnsafe()),
          (exit) => exit !== undefined,
        )
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.include(archived.reasons.join("\n"), admitted.id)
        assert.isTrue(yield* fs.exists(worktree))
      }).pipe(Effect.ensuring(split.release().pipe(Effect.ignore)))
      yield* until(
        owner.db.getSession((yield* peersSharingDirectory(owner.id))[0]!.id),
        (w) => !!w && (w.startedAt !== null || w.exitedAt !== null),
      )
    }),
  )

  test(
    "run --peer of an exited session takes the directory's lock, so another archive cannot delete the shared tree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const processes = yield* FakeProcesses
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const mid = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* until(owner.db.getSession(mid.id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
      const midPane = (yield* herdr.agent(mid.id))!.terminal
      yield* herdr.runtime.close({ id: midPane })
      yield* owner.db.updateSession(mid.id, { status: "unknown", exitedAt: 1 })
      const parked = yield* parkAdmitBeforeInsert
      const cwd = yield* processes.holdCwd()
      const split = yield* herdr.hold("open")
      const reset = Effect.sync(() => {
        peerAdmitPause.wait = Effect.void
      }).pipe(
        Effect.andThen(
          Effect.all([cwd.release(), split.release(), parked.release], { discard: true }).pipe(Effect.ignore),
        ),
      )
      yield* Effect.gen(function* () {
        const spawning = yield* Effect.forkChild(owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: mid.id }))
        yield* parked.reached
        const archiving = yield* Effect.forkChild(owner.sessions.remove(owner.id))
        const listed = yield* Effect.race(
          cwd.reached.pipe(Effect.as(true)),
          TestClock.withLive(Effect.sleep("2 seconds")).pipe(Effect.as(false)),
        )
        if (listed) {
          yield* parked.release
          yield* until(peersSharingDirectory(owner.id), (rows) =>
            rows.some((s) => s.id !== mid.id && s.exitedAt === null),
          )
          yield* cwd.release()
          const archived = (yield* Fiber.join(archiving))!
          assert.fail(
            "owner archive listed before peer-of-peer insert and removed the tree: worktree=" + archived.worktree,
          )
        }
        yield* parked.release
        yield* until(peersSharingDirectory(owner.id), (rows) => rows.some((s) => s.id !== mid.id))
        yield* cwd.release()
        const archived = (yield* Fiber.join(archiving))!
        assert.strictEqual(archived.worktree, "kept")
        assert.isTrue(yield* fs.exists(worktree))
        yield* split.release()
        yield* Fiber.join(spawning)
      }).pipe(Effect.ensuring(reset))
    }),
    undefined,
    true,
  )

  test(
    "a failed peer launch closes only the new split pane and leaves the owner's pane and worktree",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const owner = yield* idleSession(repo)
      const worktree = yield* sessionWorktree(owner.id)
      const ownerPane = (yield* herdr.agent(owner.id))!.terminal
      const closesBefore = (yield* herdr.callsTo("close")).map((c) => c.terminal)
      const created = (yield* herdr.callsTo("open")).length
      const held = yield* herdr.hold("open")
      const { id } = yield* owner.sessions.spawn({ ...(yield* spawnInput(repo)), peer: owner.id })
      yield* held.reached
      yield* held.release("failed")
      yield* until(owner.db.getSession(id), (w) => !!w && w.exitedAt !== null)
      const newCloses = (yield* herdr.callsTo("close"))
        .map((c) => c.terminal)
        .filter((pane) => !closesBefore.includes(pane))
      assert.deepStrictEqual(newCloses, [])
      assert.isTrue(HashMap.has(yield* herdr.panes, ownerPane))
      assert.isTrue(yield* fs.exists(worktree))
      assert.strictEqual((yield* herdr.callsTo("open")).length, created + 1)
      assert.strictEqual(yield* owner.db.sessionDirectory(id), yield* owner.db.sessionDirectory(owner.id))
    }),
  )
})
