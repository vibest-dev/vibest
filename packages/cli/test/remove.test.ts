import { assert, describe, it, layer } from "@effect/vitest"
import { archived, Db, executionStateOf, exitedAt } from "@vibest/core/db"
import { cwdHolders, livenessOf, parseProcessTable, Processes, runFor, sessionTree } from "@vibest/core/processes"
import { Sessions } from "@vibest/core/sessions"
import { Clock, Effect, Fiber, FileSystem, HashMap, Stream, type Scope } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

import * as Platform from "#platform"

import {
  eventsOf,
  FakeRuntime,
  FakeProcesses,
  makeRepository,
  restartSessions,
  processEnds,
  settled,
  tempDirectory,
  testLayer,
  type TestOptions,
  type TestServices,
  until,
  untilVirtual,
  writeEnd,
  systemPromptFile,
  projectOf,
  processesOn,
} from "./fakes.ts"

const test = <E>(name: string, program: Effect.Effect<void, E, TestServices | Scope.Scope>, options?: TestOptions) =>
  it.effect(name, () => program.pipe(Effect.provide(testLayer(options))))

const workingSession = Effect.gen(function* () {
  const sessions = yield* Sessions
  const db = yield* Db
  const herdr = yield* FakeRuntime
  const repo = yield* makeRepository
  const { id } = yield* sessions.spawn({
    agent: "general",
    machine: { id: "local" },
    root: repo,
    parentSessionId: "creator",
    projectId: yield* projectOf(repo),
    name: "task",
    prompt: "do it",
    runtime: "herdr",
    harness: "pi",
  })
  yield* until(db.getSession(id), (w) => !!w && ((w.process?.placedAt ?? null) !== null || exitedAt(w) !== null))
  yield* sessions.check(id)
  const pane = (yield* herdr.agent(id))!.terminal
  const row = (yield* db.getSession(id))!
  const worktree = yield* db.sessionDirectory(row.id)
  if (worktree === undefined) return yield* Effect.die(`spawned ${id} has no worktree path`)
  return { id, repo, pane, sessions, db, herdr, worktree, rules: yield* systemPromptFile(id) }
})

const idleSession = Effect.gen(function* () {
  const w = yield* workingSession
  const { id, sessions, herdr } = w
  yield* writeEnd(id, "pi", { text: "status: completed" })
  yield* herdr.endExecution(id)
  yield* sessions.check(id)
  return w
})

const removeAdvancingClock = (sessions: Sessions["Service"], id: string) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(sessions.remove(id))
    yield* untilVirtual(
      Effect.sync(() => fiber.pollUnsafe()),
      (exit) => exit !== undefined,
    )
    return yield* Fiber.join(fiber)
  })

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
    "the close's reply is lost: the record survives a vibestd restart, and the retry proves it gone",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { id, pane, sessions, db, herdr, worktree } = yield* idleSession
      const held = yield* herdr.hold("close")
      const removing = yield* Effect.forkChild(Effect.flip(sessions.remove(id)))
      yield* held.reached
      const closedButReplyLost = herdr.runtime.close({ id: pane })
      yield* closedButReplyLost
      yield* held.release("unreachable")
      assert.strictEqual((yield* Fiber.join(removing))._tag, "RuntimeUnreachable")
      const row = (yield* db.getSession(id))!
      assert.isNull(exitedAt(row))
      assert.deepStrictEqual(yield* processEnds(id), [])
      assert.isTrue(archived(row))
      assert.isTrue(yield* fs.exists(worktree))
      const freshSessions = yield* restartSessions
      assert.deepInclude(yield* freshSessions.remove(id), {
        processes: "exited",
        pane: "closed",
        worktree: "removed",
      })
      assert.isNotNull(exitedAt((yield* db.getSession(id))!))
    }),
  )

  test(
    "a close the runtime fails: the terminal is kept, nothing proven and the session not stopped, and a retry finishes; a terminal already gone counts as closed",
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
      assert.isNull(exitedAt((yield* a.db.getSession(a.id))!))
      assert.deepInclude(yield* a.sessions.remove(a.id), { pane: "closed", worktree: "removed" })

      const b = yield* idleSession
      const closeByHand = b.herdr.runtime.close({ id: b.pane })
      yield* closeByHand
      const gone = yield* b.sessions.remove(b.id)
      assert.deepInclude(gone, { processes: "exited", pane: "closed", worktree: "removed" })
      assert.isNotNull(exitedAt((yield* b.db.getSession(b.id))!))
      assert.isFalse(yield* fs.exists(b.worktree))
      assert.isFalse(yield* fs.exists(b.rules))
    }),
  )

  test(
    "worktree already gone: its rules file is removed once its processes are proven exited, and the report stays",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const worktreeDeletedOutsideVibest = (w: Effect.Success<typeof idleSession>) =>
        Effect.gen(function* () {
          yield* fs.remove(w.worktree, { recursive: true })
          yield* writeEnd(w.id, "pi", { text: `result of ${w.id}` })
          yield* fs.writeFileString(w.rules, `rules of ${w.id}`)
        })

      const reportedExecutionEndEvent = (id: string) =>
        eventsOf(id, "execution.ended").pipe(Effect.map((rows) => rows.at(-1)?.data.reply))
      const a = yield* idleSession
      yield* a.herdr.runtime.close({ id: a.pane })
      yield* worktreeDeletedOutsideVibest(a)
      yield* a.sessions.check(a.id)
      yield* until(a.db.getSession(a.id), (row) => (row ? exitedAt(row) : undefined) !== null)
      yield* settled
      assert.deepInclude(
        yield* a.sessions.remove(a.id),
        { processes: "exited", pane: "none", worktree: "gone" },
        "closed by hand: the check already saw the exit, so no terminal is left to close",
      )
      assert.strictEqual(yield* reportedExecutionEndEvent(a.id), `result of ${a.id}`)
      assert.isFalse(yield* fs.exists(a.rules))

      const b = yield* idleSession
      yield* worktreeDeletedOutsideVibest(b)
      yield* settled
      assert.deepInclude(yield* b.sessions.remove(b.id), { processes: "exited", pane: "closed", worktree: "gone" })
      assert.strictEqual(yield* reportedExecutionEndEvent(b.id), `result of ${b.id}`)
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
      const out = (yield* removeAdvancingClock(sessions, id))!
      assert.deepInclude(out, { processes: "alive", pane: "closed", worktree: "kept" })
      assert.include(out.reasons.join("\n"), "process 4242 has its working directory in it")
      assert.isNull(exitedAt((yield* db.getSession(id))!))
      assert.isTrue(yield* fs.exists(worktree))
      assert.isTrue(yield* fs.exists(rules))
      assert.strictEqual(
        (yield* Effect.flip(sessions.send(id, "come back"))).message,
        `${id} was archived; run a new session`,
      )
      yield* sessions.check(id)
      assert.isNull(exitedAt((yield* db.getSession(id))!))
      assert.lengthOf(yield* herdr.callsTo("open"), 1)

      yield* fake.setCwdUsers([])
      assert.deepInclude(yield* sessions.remove(id), { processes: "exited", worktree: "removed", reasons: [] })
      assert.isNotNull(exitedAt((yield* db.getSession(id))!))
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
      const [out] = yield* removeTimingCwd(b.sessions, b.id)
      assert.deepInclude(out!, {
        processes: "alive",
        worktree: "kept",
        reasons: ["worktree kept: process 4242 has its working directory in it"],
      })
      assert.strictEqual(
        (yield* fake.cwdListings) - before,
        1,
        "one listing, no waiting for a process that is not the session's (elapsed virtual time grows with git under load)",
      )
      const unclearListing = undefined
      yield* fake.setCwdUsers(unclearListing)
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
    "the session's own processes still exiting after the pane closes are waited out, then the worktree goes; one that is still there after the wait keeps it",
    Effect.gen(function* () {
      const leaving = yield* idleSession
      const fake = yield* FakeProcesses
      const root = (yield* leaving.db.getSession(leaving.id))!.process!.pid!
      const child = root + 1
      yield* fake.setTree(root, [root, child])
      yield* fake.set(root, "alive")
      yield* fake.set(child, "alive")
      yield* fake.setCwdUsers([child])
      const fiber = yield* Effect.forkChild(leaving.sessions.remove(leaving.id))
      yield* untilVirtual(fake.probed, (probed) => probed.includes(root) && probed.includes(child))
      yield* fake.set(root, "exited")
      yield* fake.set(child, "exited")
      yield* fake.setCwdUsers([])
      yield* untilVirtual(
        Effect.sync(() => fiber.pollUnsafe()),
        (exit) => exit !== undefined,
      )
      assert.deepInclude(yield* Fiber.join(fiber), { processes: "exited", pane: "closed", worktree: "removed" })
      assert.strictEqual(yield* fake.cwdListings, 1)

      const staying = yield* idleSession
      const stuck = (yield* staying.db.getSession(staying.id))!.process!.pid!
      yield* fake.setTree(stuck, [stuck])
      yield* fake.set(stuck, "alive")
      yield* fake.setCwdUsers([stuck])
      const kept = (yield* removeAdvancingClock(staying.sessions, staying.id))!
      assert.deepInclude(kept, { processes: "alive", pane: "closed", worktree: "kept" })
      assert.include(kept.reasons.join("\n"), `process ${stuck} has its working directory in it`)
    }),
  )

  test(
    "a listing that never returns: kept after 10 s as unfinished, never read as empty",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const fake = yield* FakeProcesses
      const { id, sessions, worktree } = yield* idleSession
      yield* fake.holdCwd()
      const out = (yield* removeAdvancingClock(sessions, id))!
      assert.deepInclude(out, {
        processes: "unknown",
        worktree: "kept",
        reasons: ["worktree kept: vibest could not finish listing this user's processes working in it within 10s"],
      })
      assert.isTrue(yield* fs.exists(worktree))
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
    "a working session is interrupted, then its terminal closed and its processes confirmed; the execution ends interrupted",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { id, sessions, db, herdr, worktree } = yield* workingSession
      const out = (yield* sessions.remove(id))!
      assert.deepInclude(out, { processes: "exited", pane: "closed", worktree: "removed" })
      assert.deepStrictEqual(out.reasons, [`${id} was working: interrupted, then its terminal closed`])
      assert.lengthOf(
        (yield* herdr.callsTo("send")).filter((c: { keys?: ReadonlyArray<string> }) => c.keys),
        1,
        "one key press, the interrupt; the spawn's prompt text is a send without keys",
      )
      const row = (yield* db.getSession(id))!
      assert.strictEqual(row.status, "unknown")
      assert.strictEqual(executionStateOf(row), "interrupted")
      assert.isNotNull(exitedAt(row))
      assert.isFalse(yield* fs.exists(worktree))
    }),
  )

  test(
    "an interrupt that does not take within 10 s still closes the session's own terminal",
    Effect.gen(function* () {
      const { id, pane, sessions, db, herdr } = yield* workingSession
      const out = (yield* removeAdvancingClock(sessions, id))!
      assert.deepInclude(out, { processes: "exited", pane: "closed" })
      assert.include(
        out.reasons.join("\n"),
        `${id} did not stop within 10s of the interrupt key; its terminal closed anyway`,
      )
      assert.isFalse(HashMap.has(yield* herdr.panes, pane))
      assert.isNotNull(exitedAt((yield* db.getSession(id))!))
    }),
    { interruptIgnored: true },
  )
})

describe.concurrent("Processes", () => {
  const lsofSet = (...fields: ReadonlyArray<string>) => `${fields.join("\0")}\0\n`
  const record = (pid: number, cwd: string) => lsofSet(`p${pid}`) + lsofSet("fcwd", `n${cwd}`)
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

  it("a record it does not expect, or a cwd lsof could not read (wherever it points, whatever the localized reason), makes the whole listing unknown", () => {
    for (const odd of [
      lsofSet("p101", "Lbash") + lsofSet("fcwd", "n/x"),
      lsofSet("p101") + lsofSet("ftxt", "n/x"),
      lsofSet("p101"),
      lsofSet("p0") + lsofSet("fcwd", "n/x"),
      lsofSet("p1x") + lsofSet("fcwd", "n/x"),
      "p101\n",
      lsofSet("p101") + record(102, "/x"),
    ])
      assert.isUndefined(cwdHolders(ok(record(self, "/home") + odd), self, dirs), JSON.stringify(odd))
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
    assert.isUndefined(cwdHolders(ok(record(self, "/home (stat: x)")), self, dirs), "the canary's own cwd unreadable")
  })

  it("the user's own systemd manager and its (sd-pam), whose cwd no one can read, leave the listing complete; any other unreadable cwd still makes it unknown", () => {
    const unreadable = (pid: number, parent: number, command: string) =>
      lsofSet(`p${pid}`, `R${parent}`, `c${command}`) +
      lsofSet("fcwd", `n/proc/${pid}/cwd (readlink: Permission denied)`)
    const manager = unreadable(1162, 1, "systemd") + unreadable(1181, 1162, "(sd-pam)")
    assert.deepStrictEqual(cwdHolders(ok(record(self, "/home") + manager + record(101, "/w/abcd")), self, dirs), [101])
    for (const [odd, why] of [
      [unreadable(1181, 1162, "(sd-pam)"), "an (sd-pam) with no user manager above it"],
      [unreadable(1162, 900, "systemd") + unreadable(1181, 1162, "(sd-pam)"), "a systemd that pid 1 did not start"],
      [manager + unreadable(1200, 1162, "(sd-pam)") + unreadable(1300, 1, "sleep"), "another program"],
      [manager + unreadable(1201, 1, "systemd").replace("/proc/1201/", "/proc/1/"), "another process's /proc entry"],
      [
        lsofSet("p1162", "R1", "csystemd") + lsofSet("fcwd", "n/w/abcd (stat: Permission denied)"),
        "a stat diagnostic, which names a real path",
      ],
      [lsofSet("p1162") + lsofSet("fcwd", "n/proc/1162/cwd (readlink: Permission denied)"), "no command or parent"],
    ])
      assert.isUndefined(cwdHolders(ok(record(self, "/home") + odd + record(101, "/w/abcd")), self, dirs), why)
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

  it("the session tree is the recorded process, its children and the shell that started it, not that shell's other children or a process outside it", () => {
    const rows = parseProcessTable(
      [
        "  10  1 herdr",
        "  20  10 -zsh",
        "  21  20 gitstatusd",
        "  30  20 node",
        "  31  30 node",
        "  40  10 sleep",
      ].join("\n"),
    )
    assert.deepStrictEqual(
      sessionTree(30, rows).toSorted((a, b) => a - b),
      [20, 30, 31],
    )
    assert.deepStrictEqual(
      sessionTree(30, [
        { pid: 30, ppid: 1, command: "node" },
        { pid: 99, ppid: 1, command: "other" },
      ]),
      [30],
    )
    assert.deepStrictEqual(
      sessionTree(30, [
        { pid: 8, ppid: 1, command: "herdr" },
        { pid: 30, ppid: 8, command: "node" },
        { pid: 31, ppid: 30, command: "sleep" },
      ]).toSorted((a, b) => a - b),
      [30, 31],
    )
    assert.deepStrictEqual(sessionTree(30, []), [30])
    assert.deepStrictEqual(parseProcessTable("not a process table\n  1 0\n"), [])
  })

  layer(Platform.services)((it) => {
    it.effect(
      "ps names the recorded process, the shell that parents it and that process's child, and not the shell's other child",
      () =>
        Effect.gen(function* () {
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const shell = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "sleep 30 & echo $!; wait"]))
          yield* Effect.addFinalizer(() => shell.kill().pipe(Effect.ignore))
          const sleepPid = Number((yield* shell.stdout.pipe(Stream.decodeText, Stream.take(1), Stream.mkString)).trim())
          const shellPid = Number(shell.pid)
          const processes = yield* Effect.gen(function* () {
            return yield* Processes
          }).pipe(
            Effect.provide(
              processesOn({
                liveness: Platform.liveness,
                terminate: () => {
                  throw new Error("this test must not signal a process")
                },
                pid: 1,
                uid: undefined,
              }),
            ),
          )
          const tree = yield* processes.tree(sleepPid)
          assert.deepStrictEqual(
            tree?.toSorted((a, b) => a - b),
            [shellPid, sleepPid].toSorted((a, b) => a - b),
          )
          assert.isFalse(tree!.includes(process.pid))
        }).pipe(Effect.scoped),
    )

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
        }).pipe(Effect.provide(processesOn(platform)))
        for (const pid of [0, -1, 1.5, Number.NaN]) assert.strictEqual(yield* p.liveness(pid), "unknown")
        assert.strictEqual(yield* p.liveness(7), "alive")
        assert.deepStrictEqual(asked, [7])
        assert.isUndefined(yield* p.cwdUsers(dirs))
      }),
    )

    it.effect(
      "an owned child (the only process probed or listed, lsof -p <its pid>), through the production layer: alive, then exited once it ended and was reaped; lsof's real NUL format names its cwd with a tab and a newline",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem
          const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
          const dir = `${yield* tempDirectory("vibest-cwd-")}/a\tb\nc`
          yield* fs.makeDirectory(dir)
          const child = yield* spawner.spawn(ChildProcess.make("sleep", ["30"], { cwd: dir }))
          yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore))
          const pid = Number(child.pid)
          const processes = yield* Effect.gen(function* () {
            return yield* Processes
          }).pipe(
            Effect.provide(
              processesOn({
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
          assert.include(stdout, "a\\tb\\nc", "lsof escapes the tab and newline")
          assert.deepStrictEqual(
            cwdHolders({ exitCode, stdout, stderr: "" }, pid, [`${real}x`]),
            [pid],
            "past the first escape the name could be anything: a directory sharing the literal prefix counts",
          )
          assert.deepStrictEqual(
            cwdHolders({ exitCode, stdout, stderr: "" }, pid, [`${real.slice(0, -"a\tb\nc".length)}z`]),
            [],
            "a directory that differs before the first escape does not count",
          )
          yield* child.kill()
          yield* child.exitCode.pipe(Effect.ignore, Effect.timeout("5 seconds"))
          assert.strictEqual(yield* processes.liveness(pid), "exited")
        }).pipe(Effect.scoped),
    )
  })

  it.live(
    "a run (an owned shell ignoring SIGTERM, standing in for a stuck lsof) cut off by an outer timeout (the 10 s cwd wait): its helper's group is ended and reaped before the timeout returns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = `${yield* tempDirectory("vibest-helper-")}/pid`
        const run = yield* runFor("sh", ["-c", `trap "" TERM; echo $$ > '${file}'; exec sleep 30`], "30 seconds").pipe(
          Effect.timeoutOption("1 second"),
        )
        assert.isTrue(run._tag === "None")
        const pid = Number((yield* fs.readFileString(file)).trim())
        assert.isTrue(pid > 0)
        assert.strictEqual(Platform.liveness(pid), "exited")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.live(
    "a zombie (a child its parent never reaps, as an old vibestd under a parent that does not wait) is exited; its live parent is alive",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
        const parent = yield* spawner.spawn(ChildProcess.make("sh", ["-c", "true & echo $!; exec sleep 30"]))
        yield* Effect.addFinalizer(() => parent.kill().pipe(Effect.ignore))
        const zombie = Number((yield* parent.stdout.pipe(Stream.decodeText, Stream.take(1), Stream.mkString)).trim())
        assert.isTrue(zombie > 0)
        yield* until(
          Effect.sync(() => Platform.liveness(zombie)),
          (seen) => seen === "exited",
        )
        assert.doesNotThrow(() => process.kill(zombie, 0), "kill 0 alone reports the zombie as alive")
        assert.strictEqual(Platform.liveness(zombie), "exited")
        assert.strictEqual(Platform.liveness(Number(parent.pid)), "alive")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.live(
    "a helper that outlives its timeout and ignores SIGTERM: SIGKILL to its own group, ended and reaped before the run returns",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const file = `${yield* tempDirectory("vibest-helper-")}/pid`
        const run = yield* runFor("sh", ["-c", `trap "" TERM; echo $$ > '${file}'; exec sleep 30`], "1 second")
        assert.isUndefined(run)
        const pid = Number((yield* fs.readFileString(file)).trim())
        assert.isTrue(pid > 0)
        assert.strictEqual(Platform.liveness(pid), "exited")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
