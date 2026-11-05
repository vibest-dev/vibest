// vibest rm's process proof (SPEC §8.6a): the runtime's close ends the session's terminal (its processes with it), the
// close is recorded on the row, and the worktree goes only once no process still works in it. The fake runtime and fake
// lsof, real git.
import { assert, describe, it, layer } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { cwdHolders, livenessOf, LSOF_KILL_AFTER, lsofArgs, Processes, runFor } from "@vibest/core/processes"
import { CWD_WAIT } from "@vibest/core/remove"
import { Sessions } from "@vibest/core/sessions"
import { Clock, Duration, Effect, Fiber, FileSystem, HashMap, Stream, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import {
  eventsOf,
  FakeRuntime,
  FakeProcesses,
  makeRepository,
  processEnds,
  settled,
  tempDirectory,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  writeResult,
  systemPromptFile,
  projectOf,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>, options?: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer(options))))

/** A session in its first turn, and the terminal its agent runs in. */
const workingSession = Effect.gen(function* () {
  const sessions = yield* Sessions
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const { id } = yield* sessions.spawn({
    machine: { id: "local" },
    root: repo,
    projectId: yield* projectOf(repo),
    name: "task",
    prompt: "do it",
    harness: "pi",
  })
  yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
  yield* sessions.check(id)
  const pane = (yield* herdr.agent(id))!.terminal
  const row = (yield* db.getSession(id))!
  const worktree = yield* db.sessionDirectory(row.id)
  if (worktree === undefined) return yield* Effect.die(`spawned ${id} has no worktree path`)
  return { id, pane, sessions, db, herdr, worktree, rules: yield* systemPromptFile(id) }
})

/** A session whose first turn is over, and the terminal its agent runs in. */
const idleSession = Effect.gen(function* () {
  const w = yield* workingSession
  const { id, sessions, herdr } = w
  yield* writeResult(id, "pi", { text: "status: completed" })
  yield* herdr.endTurn(id)
  yield* sessions.check(id)
  return w
})

/** remove, with virtual time moved past the signal-0 and cwd polling (they sleep between checks). */
const removeWaiting = (sessions: Sessions["Service"], id: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(sessions.remove(id))
    yield* untilVirtual(
      Effect.sync(() => fiber.pollUnsafe()),
      (exit) => exit !== undefined,
    )
    return yield* Fiber.join(fiber)
  })

/** remove, timed in virtual time from its first cwd listing to its outcome. */
const removeTimingCwd = (sessions: Sessions["Service"], id: string) =>
  Effect.gen(function* () {
    const held = yield* (yield* FakeProcesses).holdCwd()
    const fiber = yield* Effect.forkChild(sessions.remove(id))
    yield* held.reached
    const started = yield* Clock.currentTimeMillis
    yield* held.release()
    yield* untilVirtual(
      Effect.sync(() => fiber.pollUnsafe()),
      (exit) => exit !== undefined,
    )
    return [yield* Fiber.join(fiber), (yield* Clock.currentTimeMillis) - started] as const
  })

describe.concurrent("vibest rm: process proof", () => {
  test(
    "the terminal's close is recorded; no process works in the worktree: stopped, worktree and files removed",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fake = yield* FakeProcesses
      const { id, sessions, db, worktree, rules } = yield* idleSession
      const out = yield* sessions.remove(id)
      assert.deepInclude(out, {
        processes: "exited",
        pane: "closed",
        workspace: "none",
        worktree: "removed",
        reasons: [],
      })
      // The runtime's close is the process proof now: vibestd never probes a PID itself.
      assert.deepStrictEqual(yield* fake.probed, [])
      const row = (yield* db.getSession(id))!
      assert.isNotNull(row.exitedAt)
      assert.deepStrictEqual(yield* processEnds(id), ["archived"])
      // A 4-hex name under the repository's directory, not the session id.
      assert.match(worktree.split("/").at(-1)!, /^[0-9a-f]{4}$/)
      assert.isFalse(yield* fs.exists(worktree))
      assert.isFalse(yield* fs.exists(rules))
    }),
  )

  test(
    "an archive ends its process once, and no PID is ever asked about",
    Effect.gen(function* () {
      const fake = yield* FakeProcesses
      const { id, sessions } = yield* idleSession
      assert.deepInclude(yield* sessions.remove(id), { processes: "exited", pane: "closed", worktree: "removed" })
      assert.deepStrictEqual(yield* processEnds(id), ["archived"])
      assert.deepStrictEqual(yield* fake.probed, [])
    }),
  )

  test(
    "the close's reply is lost: the record survives a vibestd restart, and the retry proves it gone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { id, pane, sessions, db, herdr, worktree } = yield* idleSession
      const held = yield* herdr.hold("close")
      const removing = yield* Effect.forkChild(Effect.flip(sessions.remove(id)))
      yield* held.reached
      // The runtime closed the terminal, but the connection broke before its reply.
      yield* herdr.runtime.close({ machine: "local", id: pane })
      yield* held.release("unreachable")
      assert.strictEqual((yield* Fiber.join(removing))._tag, "RuntimeUnreachable")
      const row = (yield* db.getSession(id))!
      assert.isNull(row.exitedAt)
      assert.deepStrictEqual(yield* processEnds(id), [])
      assert.isTrue(row.metadata.archived)
      assert.isTrue(row.metadata.removed)
      assert.isTrue(yield* fs.exists(worktree))
      // A new vibestd: nothing in memory, the row has the record.
      const restarted = yield* Sessions.make({ maxSessions: undefined })
      assert.deepInclude(yield* restarted.remove(id), { processes: "exited", pane: "closed", worktree: "removed" })
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
    }),
  )

  test(
    "a close the runtime fails: the terminal is kept and nothing proven; a terminal already gone counts as closed",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const a = yield* idleSession
      const held = yield* a.herdr.hold("close")
      const removing = yield* Effect.forkChild(a.sessions.remove(a.id))
      yield* held.reached
      yield* held.release("failed")
      assert.deepInclude(yield* Fiber.join(removing), { processes: "unknown", pane: "kept", worktree: "kept" })
      assert.isTrue(HashMap.has(yield* a.herdr.panes, a.pane))
      assert.deepStrictEqual(yield* processEnds(a.id), [])

      // Closed by hand before vibest rm: the runtime has no such terminal, so it is already gone by the close contract.
      const b = yield* idleSession
      yield* b.herdr.runtime.close({ machine: "local", id: b.pane })
      const gone = yield* b.sessions.remove(b.id)
      assert.deepInclude(gone, { processes: "exited", pane: "closed", worktree: "removed" })
      assert.isNotNull((yield* b.db.getSession(b.id))!.exitedAt)
      assert.isFalse(yield* fs.exists(b.worktree))
      assert.isFalse(yield* fs.exists(b.rules))
    }),
  )

  test(
    "worktree already gone: its rules file is removed once its processes are proven exited, and the report stays",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      /** The session's worktree deleted outside vibest, and its result and rules files with recognizable contents. */
      const seeded = (w: Effect.Success<typeof idleSession>) =>
        Effect.gen(function* () {
          yield* fs.remove(w.worktree, { recursive: true })
          yield* writeResult(w.id, "pi", { text: `result of ${w.id}` })
          yield* fs.writeFileString(w.rules, `rules of ${w.id}`)
        })

      // Its terminal closed by hand: the close contract already proved its processes gone, so the rules file goes. The
      // report's own check has already seen the exit, so there is no terminal left to close.
      // The reported turn end is an event, not a file, so archive does not drop it.
      const reported = (id: string) => eventsOf(id, "turn.reported").pipe(Effect.map((rows) => rows.at(-1)?.data.text))
      const a = yield* idleSession
      yield* a.herdr.runtime.close({ machine: "local", id: a.pane })
      yield* seeded(a)
      yield* until(a.db.getSession(a.id), (row) => row?.exitedAt !== null)
      yield* settled
      assert.deepInclude(yield* a.sessions.remove(a.id), { processes: "exited", pane: "none", worktree: "gone" })
      assert.strictEqual(yield* reported(a.id), `result of ${a.id}`)
      assert.isFalse(yield* fs.exists(a.rules))

      // Its terminal closed by vibest rm and no process in it: the rules file goes as well.
      const b = yield* idleSession
      yield* seeded(b)
      yield* settled
      assert.deepInclude(yield* b.sessions.remove(b.id), { processes: "exited", pane: "closed", worktree: "gone" })
      assert.strictEqual(yield* reported(b.id), `result of ${b.id}`)
      assert.isFalse(yield* fs.exists(b.rules))
    }),
  )

  test(
    "a process still in the worktree: not removed, worktree and rules kept, Send refused; once it exits, vibest rm again finishes",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fake = yield* FakeProcesses
      const { id, sessions, db, herdr, worktree, rules } = yield* idleSession
      yield* fake.setCwdUsers([4242])
      const out = (yield* removeWaiting(sessions, id))!
      assert.deepInclude(out, { processes: "alive", pane: "closed", worktree: "kept" })
      assert.include(out.reasons.join("\n"), "process 4242 has its working directory in it")
      assert.isNull((yield* db.getSession(id))!.exitedAt)
      assert.isTrue(yield* fs.exists(worktree))
      assert.isTrue(yield* fs.exists(rules))
      assert.strictEqual(
        (yield* Effect.flip(sessions.send(id, "come back"))).message,
        `${id} was archived; run a new session`,
      )
      yield* sessions.check(id)
      assert.isNull((yield* db.getSession(id))!.exitedAt)
      assert.lengthOf(yield* herdr.callsTo("open"), 1)

      yield* fake.setCwdUsers([])
      assert.deepInclude(yield* sessions.remove(id), { processes: "exited", worktree: "removed", reasons: [] })
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
      assert.isFalse(yield* fs.exists(rules))
    }),
  )

  test(
    "someone working in the worktree, or no cwd listing: the worktree is kept after one listing, the reason naming the process",
    Effect.gen(function* () {
      const fake = yield* FakeProcesses
      const b = yield* idleSession
      yield* fake.setCwdUsers([4242])
      const before = yield* fake.cwdListings
      const [out, took] = yield* removeTimingCwd(b.sessions, b.id)
      assert.deepInclude(out!, {
        processes: "alive",
        worktree: "kept",
        reasons: ["worktree kept: process 4242 has its working directory in it"],
      })
      // One listing, no waiting for the process to leave (the test moves virtual time in steps while git runs).
      assert.strictEqual((yield* fake.cwdListings) - before, 1)
      assert.isBelow(took, Duration.toMillis(CWD_WAIT))
      // An unclear listing keeps it too.
      yield* fake.setCwdUsers(undefined)
      assert.deepInclude(yield* b.sessions.remove(b.id), {
        worktree: "kept",
        reasons: [
          "worktree kept: vibest could not get a complete list of this user's processes working in it (lsof missing, failed, warned or timed out)",
        ],
      })
      yield* fake.setCwdUsers([])
      assert.deepInclude(yield* b.sessions.remove(b.id), { processes: "exited", worktree: "removed" })
    }),
  )

  test(
    "a slow listing (lsof taking 3 s) is still one listing: kept after it, naming the process",
    Effect.gen(function* () {
      const fake = yield* FakeProcesses
      const { id, sessions } = yield* idleSession
      yield* fake.setCwdUsers([4242])
      yield* fake.setCwdDelay("3 seconds")
      const before = yield* fake.cwdListings
      const [out, took] = yield* removeTimingCwd(sessions, id)
      assert.deepInclude(out!, {
        processes: "alive",
        worktree: "kept",
        reasons: ["worktree kept: process 4242 has its working directory in it"],
      })
      assert.strictEqual((yield* fake.cwdListings) - before, 1)
      assert.isBelow(took, Duration.toMillis(CWD_WAIT))
    }),
  )

  test(
    "a listing that never returns: kept after 10 s as unfinished, never read as empty",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fake = yield* FakeProcesses
      const { id, sessions, worktree } = yield* idleSession
      yield* fake.holdCwd()
      const out = (yield* removeWaiting(sessions, id))!
      assert.deepInclude(out, {
        processes: "unknown",
        worktree: "kept",
        reasons: ["worktree kept: vibest could not finish listing this user's processes working in it within 10s"],
      })
      assert.isTrue(yield* fs.exists(worktree))
    }),
  )

  test(
    "a fast empty listing removes the worktree without waiting",
    Effect.gen(function* () {
      const { id, sessions } = yield* idleSession
      const started = yield* Clock.currentTimeMillis
      assert.deepInclude(yield* sessions.remove(id), { processes: "exited", worktree: "removed", reasons: [] })
      assert.strictEqual((yield* Clock.currentTimeMillis) - started, 0)
    }),
  )

  test(
    "a terminal opened beside it while vibest rm runs stays: vibest closes only its own terminal",
    Effect.gen(function* () {
      const { id, pane, sessions, herdr } = yield* idleSession
      const workspace = pane.split(":")[0]!
      const held = yield* herdr.hold("close")
      const removing = yield* Effect.forkChild(sessions.remove(id))
      yield* held.reached
      yield* herdr.addPane(`${workspace}:user`, workspace, "/elsewhere")
      yield* held.release()
      const out = (yield* Fiber.join(removing))!
      assert.deepInclude(out, { processes: "exited", pane: "closed", workspace: "none" })
      assert.isTrue(HashMap.has(yield* herdr.panes, `${workspace}:user`))
    }),
  )

  test(
    "a working session is interrupted, then its terminal closed and its processes confirmed; the turn ends interrupted",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { id, sessions, db, herdr, worktree } = yield* workingSession
      const out = (yield* sessions.remove(id))!
      assert.deepInclude(out, { processes: "exited", pane: "closed", worktree: "removed" })
      assert.deepStrictEqual(out.reasons, [`${id} was working: interrupted, then its terminal closed`])
      // Exactly one key press goes to the pane: the interrupt (the spawn's prompt text is a send of its own).
      assert.lengthOf(
        (yield* herdr.callsTo("send")).filter((c: { keys?: ReadonlyArray<string> }) => c.keys),
        1,
      )
      const row = (yield* db.getSession(id))!
      assert.deepInclude(row, { status: "unknown", turnState: "interrupted" })
      assert.isNotNull(row.exitedAt)
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )

  test(
    "an interrupt that does not take within 10 s still closes the session's own terminal",
    Effect.gen(function* () {
      const { id, pane, sessions, db, herdr } = yield* workingSession
      const out = (yield* removeWaiting(sessions, id))!
      assert.deepInclude(out, { processes: "exited", pane: "closed" })
      assert.include(
        out.reasons.join("\n"),
        `${id} did not stop within 10s of the interrupt key; its terminal closed anyway`,
      )
      assert.isFalse(HashMap.has(yield* herdr.panes, pane))
      assert.isNotNull((yield* db.getSession(id))!.exitedAt)
    }),
    { interruptIgnored: true },
  )
})

describe.concurrent("Processes", () => {
  // lsof -Fpn0: every field ends in NUL, every process or file set in NL.
  const set = (...fields: ReadonlyArray<string>) => `${fields.join("\0")}\0\n`
  const record = (pid: number, cwd: string) => set(`p${pid}`) + set("fcwd", `n${cwd}`)
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "" })
  const self = 7
  const dirs = ["/private/w/abcd", "/w/abcd"]
  const listing =
    record(self, "/home") +
    record(101, "/w/abcd") +
    record(102, "/private/w/abcd/src") +
    record(103, "/w/abcdef") +
    record(104, "/")

  it("signal 0's errors: ESRCH exited, EPERM alive, anything else (or a throw without a code) unknown", () => {
    const throwing = (e: unknown) => () => {
      throw e
    }
    assert.strictEqual(
      livenessOf(() => {}),
      "alive",
    )
    assert.strictEqual(livenessOf(throwing(Object.assign(new Error("x"), { code: "ESRCH" }))), "exited")
    assert.strictEqual(livenessOf(throwing(Object.assign(new Error("x"), { code: "EPERM" }))), "alive")
    for (const e of [Object.assign(new Error("x"), { code: "EINVAL" }), new Error("x"), null, "ESRCH"])
      assert.strictEqual(livenessOf(throwing(e)), "unknown")
  })

  it("asks lsof for this user's processes only (numeric -u, ANDed), warnings forced on (+w), as an argument array", () => {
    assert.deepStrictEqual(lsofArgs(501), ["+w", "-a", "-u", "501", "-d", "cwd", "-Fpfn0"])
  })

  it("lists only the target's holders, under either spelling of the directory", () => {
    assert.deepStrictEqual(cwdHolders(ok(listing), self, dirs), [101, 102])
  })

  it("not complete, so not an answer: no canary, empty, a warning, a failure, no run at all", () => {
    assert.isUndefined(cwdHolders(ok(record(101, "/w/abcd")), self, dirs))
    assert.isUndefined(cwdHolders(ok(""), self, dirs))
    assert.isUndefined(
      cwdHolders(
        { exitCode: 0, stdout: listing, stderr: "lsof: WARNING: can't stat() fuse file system /x\n" },
        self,
        dirs,
      ),
    )
    assert.isUndefined(cwdHolders({ exitCode: 1, stdout: listing, stderr: "" }, self, dirs))
    assert.isUndefined(cwdHolders(undefined, self, dirs))
  })

  it("a record it does not expect makes the listing unknown", () => {
    for (const odd of [
      set("p101", "cbash") + set("fcwd", "n/x"),
      set("p101") + set("ftxt", "n/x"),
      set("p101"),
      set("p0") + set("fcwd", "n/x"),
      set("p1x") + set("fcwd", "n/x"),
      "p101\n",
      set("p101") + record(102, "/x"),
    ])
      assert.isUndefined(cwdHolders(ok(record(self, "/home") + odd), self, dirs), JSON.stringify(odd))
  })

  it("a cwd lsof could not read makes the whole listing unknown, wherever it points and whatever the (localized) reason", () => {
    for (const odd of [
      "/proc/42/cwd (readlink: Permission denied)",
      "/proc/42/cwd (readlink: Keine Berechtigung)",
      "/elsewhere (stat: Permission denied)",
      "/w/abcd (stat: Stale file handle)",
    ])
      assert.isUndefined(
        cwdHolders(ok(record(self, "/home") + record(42, odd) + record(101, "/w/abcd")), self, dirs),
        odd,
      )
    // The canary's own cwd unreadable too.
    assert.isUndefined(cwdHolders(ok(record(self, "/home (stat: x)")), self, dirs))
  })

  it("an escaped or deleted cwd counts when it could be the target", () => {
    assert.deepStrictEqual(
      cwdHolders(
        ok(
          record(self, "/home") +
            record(201, "/w/ab\\tcd/x") +
            record(202, "/w/abcd (deleted)") +
            record(203, "/other\\x09"),
        ),
        self,
        dirs,
      ),
      [201, 202],
    )
  })

  layer(Platform.services)((it) => {
    it.effect("signal 0 is only ever asked about a positive integer PID; no user id, no listing", () =>
      Effect.gen(function* () {
        const asked: Array<number> = []
        const platform = {
          liveness: (pid: number) => (asked.push(pid), "alive" as const),
          terminate: () => {
            throw new Error("this test must not signal a process")
          },
          pid: self,
          uid: undefined,
        }
        const p = yield* Effect.gen(function* () {
          return yield* Processes
        }).pipe(Effect.provide(Processes.layer(platform)))
        for (const pid of [0, -1, 1.5, Number.NaN]) assert.strictEqual(yield* p.liveness(pid), "unknown")
        assert.strictEqual(yield* p.liveness(7), "alive")
        assert.deepStrictEqual(asked, [7])
        assert.isUndefined(yield* p.cwdUsers(dirs))
      }),
    )

    // Only a child this test starts is probed or listed (lsof -p <its pid>), never anyone else's processes.
    it.effect(
      "an owned child, through the production layer: alive, then exited once it ended and was reaped; lsof's real NUL format names its cwd with a tab and a newline",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const dir = `${yield* tempDirectory("vibest-cwd-")}/a\tb\nc`
          yield* fs.makeDirectory(dir)
          const child = yield* spawner.spawn(ChildProcess.make("sleep", ["30"], { cwd: dir }))
          // Only this child is ever ended, however the test goes.
          yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore))
          const pid = Number(child.pid)
          const processes = yield* Effect.gen(function* () {
            return yield* Processes
          }).pipe(
            Effect.provide(
              Processes.layer({
                liveness: Platform.liveness,
                terminate: () => {
                  throw new Error("this test must not signal a process")
                },
                pid: 1,
                uid: undefined,
              }),
            ),
          )
          assert.strictEqual(yield* processes.liveness(pid), "alive")
          const lsof = yield* spawner.spawn(
            ChildProcess.make("lsof", ["+w", "-a", "-p", String(pid), "-d", "cwd", "-Fpfn0"]),
          )
          const [stdout, exitCode] = yield* Effect.all([Stream.mkString(Stream.decodeText(lsof.stdout)), lsof.exitCode])
          const real = yield* fs.realPath(dir)
          assert.deepStrictEqual(
            cwdHolders({ exitCode, stdout, stderr: "" }, pid, [real]),
            [pid],
            JSON.stringify(stdout),
          )
          // lsof escapes the tab and newline (\\t, \\n): past the first escape the name could be anything, so a directory
          // that shares its literal prefix counts too; one that differs before it does not.
          assert.include(stdout, "a\\tb\\nc")
          assert.deepStrictEqual(cwdHolders({ exitCode, stdout, stderr: "" }, pid, [`${real}x`]), [pid])
          assert.deepStrictEqual(
            cwdHolders({ exitCode, stdout, stderr: "" }, pid, [`${real.slice(0, -"a\tb\nc".length)}z`]),
            [],
          )
          yield* child.kill()
          yield* child.exitCode.pipe(Effect.ignore, Effect.timeout("5 seconds"))
          assert.strictEqual(yield* processes.liveness(pid), "exited")
        }).pipe(Effect.scoped),
    )
  })

  // The helper here is an owned shell that ignores SIGTERM, standing in for a stuck lsof. Real time.
  it.live(
    "a run cut off by an outer timeout (the 10 s cwd wait): its helper's group is ended and reaped before the timeout returns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = `${yield* tempDirectory("vibest-helper-")}/pid`
        const started = Date.now()
        const run = yield* runFor("sh", ["-c", `trap "" TERM; echo $$ > '${file}'; exec sleep 30`], "30 seconds").pipe(
          Effect.timeoutOption("1 second"),
        )
        const elapsed = Date.now() - started
        assert.isTrue(run._tag === "None")
        const pid = Number((yield* fs.readFileString(file)).trim())
        assert.isTrue(pid > 0)
        assert.isAtLeast(elapsed, 1000 + Duration.toMillis(LSOF_KILL_AFTER))
        assert.isBelow(elapsed, 10_000)
        assert.strictEqual(Platform.liveness(pid), "exited")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.live(
    "a helper that outlives its timeout and ignores SIGTERM: SIGKILL to its own group, ended and reaped before the run returns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = `${yield* tempDirectory("vibest-helper-")}/pid`
        const started = Date.now()
        const run = yield* runFor("sh", ["-c", `trap "" TERM; echo $$ > '${file}'; exec sleep 30`], "1 second")
        const elapsed = Date.now() - started
        assert.isUndefined(run)
        const pid = Number((yield* fs.readFileString(file)).trim())
        assert.isTrue(pid > 0)
        // SIGTERM did nothing: it lived until SIGKILL, LSOF_KILL_AFTER later.
        assert.isAtLeast(elapsed, 1000 + Duration.toMillis(LSOF_KILL_AFTER))
        assert.isBelow(elapsed, 10_000)
        assert.strictEqual(Platform.liveness(pid), "exited")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
