import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Layout } from "@vibest/core/paths"
import { Plugin } from "@vibest/plugin"
import { Effect, Fiber, FileSystem, Path } from "effect"
import { TestClock } from "effect/testing"

import { KIND } from "./fake-runtime.ts"
import {
  callerPlugin,
  FakeGit,
  FakeRuntime,
  makeRepository,
  tempDirectory,
  until,
  projectOf,
  systemPromptFile,
} from "./fakes.ts"
import { test, client, asCli } from "./rpc-helpers.ts"

describe("vibest.sock", () => {
  test(
    "Launch types the harness with an env prefix and does not put identity in the pane",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const layout = yield* Layout
      const db = yield* Db
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const opened = yield* c.Launch({
        callerEnv: {},
        argv: ["/bin/vibest", "--harness", "pi", "--model", "it's"],
        focus: true,
        runtime: "herdr",
      })
      const root = repo
      const entry = yield* db.entryOf(yield* projectOf(repo))
      assert.ok(entry)
      assert.deepStrictEqual(opened, {
        runtime: "herdr",
        terminal: opened.terminal,
        place: `herdr ${opened.terminal}`,
        attach: ["fake", "attach"],
      })
      const [open] = yield* herdr.callsTo("open")
      assert.deepStrictEqual(
        { ...open, env: undefined },
        {
          project: root,
          cwd: root,
          argv: ["sh", "-c", '"$@"; exec "${SHELL:-/bin/sh}"', "sh"],
          env: undefined,
          label: "vibest",
          near: undefined,
          split: undefined,
          focus: true,
        },
      )
      assert.strictEqual(open!.env["VIBEST_SESSION_ID"], undefined)
      assert.strictEqual(open!.env["VIBEST_HOME"], layout.home)
      const [ran] = yield* herdr.callsTo("run")
      assert.strictEqual(ran!.terminal, opened.terminal)
      assert.strictEqual(ran!.argv[0], "env")
      assert.ok(ran!.argv.includes(`VIBEST_SESSION_ID=${entry!.id}`))
      assert.includeMembers([...ran!.argv], ["pi", "--model", "it's"])
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
    }),
  )

  test(
    "Project.Create resolves a relative directory and --from against the cli directory",
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const parent = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "vibest-create-" }))
      const init = (name: string) =>
        Effect.gen(function* () {
          const dir = path.join(parent, name)
          yield* fs.makeDirectory(dir)
          yield* fs.writeFileString(path.join(dir, "f"), "x\n")
          yield* (yield* FakeGit).repository(dir, { files: { f: "x\n" } })
        })
      yield* init("a")
      yield* init("b")
      const created = yield* asCli(yield* client, parent)["Project.Create"]({
        directory: "combo",
        from: ["a", "b"],
      })
      assert.strictEqual(created.directory, path.join(parent, "combo"))
      assert.deepStrictEqual(
        created.folders.map((folder) => folder.name),
        ["a", "b"],
      )
      assert.isTrue(yield* fs.exists(path.join(parent, "combo", "a", "f")))
    }),
  )

  test(
    "Project.EntryPlace names the detected terminal, and launches a named runtime that is not here",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const opened = yield* c["Project.Open"]({})
      const here = yield* c["Project.EntryPlace"]({ callerEnv: { HC_ID: "t1", HERDR_ID: "p1" } })
      assert.strictEqual(here.directory, opened.directory)
      assert.deepStrictEqual(here.place, { in: "terminal", runtime: "herdr", terminal: "p1" })
      assert.deepStrictEqual((yield* c["Project.EntryPlace"]({ callerEnv: { HC_ID: "t1" }, runtime: "herdr" })).place, {
        in: "launch",
        runtime: "herdr",
      })
    }),
    {
      plugins: [
        callerPlugin("hc", {
          env: ["HC_ID"],
          terminal: (env) => Effect.succeed(env.HC_ID),
        }),
        callerPlugin("herdr", {
          env: ["HERDR_ID"],
          terminal: (env) => Effect.succeed(env.HERDR_ID),
        }),
      ],
    },
  )

  test(
    "Project.EntryPlace issued while a runtime plugin is still activating waits for it and detects its caller",
    Effect.gen(function* () {
      const c = asCli(yield* client, yield* makeRepository)
      const place = yield* c["Project.EntryPlace"]({ callerEnv: { SLOW_ID: "s1" } }).pipe(Effect.forkChild)
      yield* TestClock.withLive(Effect.sleep("200 millis"))
      yield* TestClock.adjust("1 second")
      assert.deepStrictEqual((yield* Fiber.join(place)).place, { in: "terminal", runtime: "slow", terminal: "s1" })
    }),
    {
      activateLate: true,
      plugins: [
        Plugin.define({
          id: "runtime-slow-caller",
          effect: (context) =>
            Effect.sleep("1 second").pipe(
              Effect.andThen(
                context.runtime.transform((editor) =>
                  editor.add({
                    ...editor.get(KIND)!,
                    id: "slow",
                    caller: { env: ["SLOW_ID"], terminal: (env) => Effect.succeed(env.SLOW_ID) },
                  }),
                ),
              ),
              Effect.asVoid,
            ),
        }),
      ],
    },
  )

  test(
    "a runtime that is not ready is LaunchFailed with the plugin's missing message",
    Effect.gen(function* () {
      const c = asCli(yield* client, yield* makeRepository)
      const refused = yield* Effect.flip(c["Project.EntryPlace"]({ callerEnv: { HC_ID: "t1" } }))
      assert.strictEqual(refused._tag, "LaunchFailed")
      assert.strictEqual(refused.message, "hc socket is down")
    }),
    {
      plugins: [
        callerPlugin("hc", {
          env: ["HC_ID"],
          terminal: (env) => Effect.succeed(env.HC_ID),
          ready: () => Effect.succeed(false),
          missing: "hc socket is down",
        }),
      ],
    },
  )

  test(
    "Project.EntrySession returns the harness command and writes the system prompt before the claim is used",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const fs = yield* FileSystem.FileSystem
      const layout = yield* Layout
      const c = asCli(yield* client, repo)
      const started = yield* c["Project.EntrySession"]({
        harness: "pi",
        fresh: true,
        terminal: "test/p1",
        runtime: "herdr",
      })
      assert.strictEqual(started.command.file, "pi")
      assert.strictEqual(started.command.env.VIBEST_SESSION_ID, started.sessionId)
      assert.strictEqual(started.command.env.VIBEST_PROJECT_DIR, layout.project(started.projectId))
      assert.strictEqual(yield* fs.exists(yield* systemPromptFile(started.sessionId)), true)
      assert.strictEqual(yield* fs.exists(layout.artifacts(started.projectId)), true)
    }),
  )

  test(
    "a harness not on PATH fails before any row is claimed",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const db = yield* Db
      const c = asCli(yield* client, repo)
      const failed = yield* Effect.flip(
        c["Project.EntrySession"]({ harness: "pi", fresh: true, terminal: "test/p9", runtime: "herdr" }),
      )
      assert.strictEqual(failed._tag, "HarnessUnavailable")
      assert.deepStrictEqual(yield* db.listSessions(), [])
    }),
    { missingBinary: ["pi"] },
  )

  test(
    "Spawn and Launch open at the caller target, and runtimeSession wins",
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const c = asCli(yield* client, repo)
      const herdr = yield* FakeRuntime
      const socket = JSON.stringify({ socketPath: "/h.sock" })
      const named = JSON.stringify({ session: "other" })
      yield* c.Spawn({
        harness: "pi",
        prompt: "do it",
        callerEnv: { HERDR_SOCKET_PATH: "/h.sock", SECRET: "no" },
      })
      yield* until(herdr.callsTo("open"), (calls) => calls.length > 0)
      assert.strictEqual((yield* herdr.callsTo("open"))[0]?.target, socket)
      yield* c.Launch({
        argv: ["/bin/vibest", "--harness", "pi"],
        focus: false,
        runtime: "herdr",
        callerEnv: { HERDR_SOCKET_PATH: "/h.sock" },
        runtimeSession: "other",
      })
      assert.strictEqual((yield* herdr.callsTo("open")).at(-1)?.target, named)
    }),
    {
      plugins: [
        callerPlugin("herdr", {
          env: ["HERDR_SOCKET_PATH"],
          terminal: () => Effect.succeed("pane"),
          target: (env, named) =>
            named !== undefined
              ? JSON.stringify({ session: named })
              : env.HERDR_SOCKET_PATH === undefined
                ? undefined
                : JSON.stringify({ socketPath: env.HERDR_SOCKET_PATH }),
        }),
      ],
    },
  )

  test(
    "Launch from a linked worktree opens at the repository's root, not a second parent",
    Effect.gen(function* () {
      const herdr = yield* FakeRuntime
      const repo = yield* makeRepository
      const linked = `${yield* tempDirectory("vibest-linked-")}/wt`
      yield* (yield* FakeGit).git.addWorktree(repo, linked)
      yield* asCli(yield* client, linked).Launch({
        callerEnv: {},
        argv: ["/bin/vibest", "--harness", "pi"],
        focus: false,
        runtime: "herdr",
      })
      assert.deepStrictEqual(
        (yield* herdr.callsTo("open")).map((p) => [p.project, p.cwd]),
        [[repo, repo]],
      )
      assert.deepStrictEqual(yield* herdr.callsTo("send"), [])
    }),
  )

  test(
    "ls, result and peek keep reading a session started in one runtime after agents start in another",
    Effect.gen(function* () {
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const c = asCli(yield* client, yield* makeRepository)
      const before = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "in herdr", runtime: "herdr" })
      const after = yield* c.Spawn({ callerEnv: {}, harness: "pi", prompt: "in hc", runtime: "hc" })
      for (const id of [before.id, after.id]) yield* until(db.getSession(id), (s) => s?.executionState === "open")
      const rows = (yield* c.List({})).sessions
      assert.deepStrictEqual(
        [before.id, after.id].map((id) => rows.find((row) => row.id === id)?.runtime),
        ["herdr", "hc"],
      )
      for (const id of [before.id, after.id]) {
        assert.strictEqual((yield* c.Get({ id })).id, id)
        assert.deepStrictEqual(yield* c.Peek({ id }), { text: "pane tail" })
      }
      assert.strictEqual((yield* herdr.callsTo("read")).length, 2)
    }),
    {
      plugins: [callerPlugin("hc", { env: ["HC_ID"], terminal: (env) => Effect.succeed(env.HC_ID) })],
    },
  )
})
