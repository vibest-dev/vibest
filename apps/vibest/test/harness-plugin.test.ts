// A harness a plugin registers with `context.harness.register` runs like a built-in: `vibest run <id>` starts it.
import { assert, it } from "@effect/vitest"
import { Db } from "@vibest/core/db"
import { Inbox } from "@vibest/core/inbox"
import { Layout } from "@vibest/core/paths"
import { Sessions } from "@vibest/core/sessions"
import { Plugin } from "@vibest/plugin"
import type { Harness } from "@vibest/plugin"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { KIND as RUNTIME } from "@vibest/runtime-herdr/terminal-runtime"
import * as Http from "@vibest/server/http"
import { repositoryKey } from "@vibest/vibest/worktree"
import { Effect } from "effect"
import * as Headers from "effect/http/Headers"
import { TestClock } from "effect/testing"

import { FakeRuntime, makeRepository, testLayer, until, launchMain } from "./fakes.ts"
import { hookcliPlugin } from "./fixtures/harness-hookcli.ts"

const fake: Harness.HarnessAdapter = {
  id: "fakecli",
  binary: "fakecli",
  conversation: "assigned",
  systemPromptInPrompt: false,
  interruptKey: "esc",
  delivery: "type",
  reportsState: false,
  checkProvider: () => undefined,
  // A per-session config directory under scratch: how a plugin harness loads its own integration for one session.
  launchArgs: (i) => ["--session", i.sessionId!, "--config", `${i.scratch}/fakecli`, "--rules", i.systemPromptFile],
  models: { args: () => ["models"], answer: () => [{ model: "m", default: true }] },
}

const plugin = Plugin.define({ id: "harness-fakecli", effect: (ctx) => ctx.harness.register(fake) })

it.effect("a plugin harness is spawned by its id", () =>
  Effect.gen(function* () {
    const repo = yield* makeRepository
    const db = yield* Db
    const key = yield* repositoryKey(repo)
    yield* launchMain(key, "pi", false, { runtime: RUNTIME, address: { machine: "local", id: "test/coord" } })
    const { id } = yield* (yield* Sessions).spawn({
      machine: { id: "local" },
      root: repo,
      key,
      name: "task",
      prompt: "do it",
      harness: "fakecli",
    })
    yield* until(db.getSession(id), (w) => !!w && (w.startedAt !== null || w.exitedAt !== null))
    const row = (yield* db.getSession(id))!
    assert.strictEqual(row.harnessId, "fakecli")
    const open = (yield* (yield* FakeRuntime).callsTo("open")).at(-1)!
    assert.strictEqual(open.argv[0], "fakecli")
    assert.deepStrictEqual(open.argv.slice(1, 3), ["--session", row.harnessSessionId!])
  }).pipe(Effect.provide(testLayer({ plugins: [plugin] }))),
)

// The example shell-hook harness (test/fixtures/harness-hookcli.ts): one whole round through its hooks alone.
it.effect(
  "a shell-hook plugin harness: its hooks start, guard and end a turn, the result reaches the main agent, and an interrupt ends the next turn with none",
  () =>
    Effect.gen(function* () {
      const repo = yield* makeRepository
      const db = yield* Db
      const herdr = yield* FakeRuntime
      const sessions = yield* Sessions
      const layout = yield* Layout
      const key = yield* repositoryKey(repo)
      const main = yield* launchMain(key, "pi", false, {
        runtime: RUNTIME,
        address: { machine: "local", id: "test/coord" },
      })
      yield* herdr.seedAgent("test/coord")
      const { id } = yield* sessions.spawn({
        machine: { id: "local" },
        root: repo,
        key,
        name: "hookcli work",
        prompt: "write the parser",
        harness: "hookcli",
      })
      // Started with its hook config on the command line, every hook a `vibest integration event` call.
      const open = (yield* until(herdr.callsTo("open"), (calls) => calls.length > 0)).at(-1)!
      assert.strictEqual(open.argv[0], "hookcli")
      const hooks = JSON.parse(open.argv[open.argv.indexOf("--hooks") + 1]!) as Record<string, string>
      assert.match(hooks.reply!, /integration event --harness hookcli reply$/)
      // check takes the session's lock, so this waits for the launch (prompt and confirm) to finish.
      yield* until(db.getSession(id), (s) => !!s && (s.startedAt !== null || s.exitedAt !== null))
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "open")

      // What `vibest integration event --harness hookcli <hook>` posts for each hook.
      const handle = yield* Http.make
      const hook = (name: string, payload: Record<string, unknown>) =>
        handle({
          path: "/hook",
          headers: Headers.fromInput(
            sessionHeaders({ sessionId: id, projectId: String(main.projectId), harness: "hookcli" }),
          ),
          body: JSON.stringify({ hook: name, payload }),
        })
      yield* hook("session", { id: "conv-1" })
      assert.strictEqual((yield* db.getSession(id))!.harnessSessionId, "conv-1")
      yield* hook("prompt", { prompt: "write the parser" })
      const refused = yield* hook("pre_tool", {
        tool: "Write",
        input: { file_path: `${layout.projects}/x/memory/a.md` },
        cwd: repo,
      })
      assert.strictEqual((refused.body as { output: { decision: string } }).output.decision, "deny")
      const allowed = yield* hook("pre_tool", { tool: "Read", input: { file_path: "src/a.ts" }, cwd: repo })
      assert.deepStrictEqual((allowed.body as { output: unknown }).output, { decision: "allow" })
      // A turn end counts only when it is newer than the prompt it answers.
      yield* TestClock.adjust("1 second")
      assert.strictEqual((yield* hook("reply", { text: "parser done\nstatus: completed" })).status, 200)
      yield* herdr.endTurn(id)
      yield* sessions.check(id)
      // The result is the main agent's: its Pi integration polls it, and acks it once Pi took it.
      const inbox = yield* Inbox
      const batch = yield* until(inbox.poll(main.scope), (b) => b.ids.length > 0)
      assert.include(batch.text, "parser done")
      yield* inbox.ack(main.scope, batch.ids)
      assert.strictEqual((yield* db.latestInbox(id, "result"))!.status, "delivered")

      // The next turn, interrupted: the interrupt key goes in, the stop hook says aborted, and no result arrives.
      const results = (yield* db.latestInbox(id, "result"))!.id
      yield* TestClock.adjust("1 second")
      yield* sessions.send(id, "now the tests")
      yield* until(db.getSession(id), (s) => s?.turnState === "open")
      yield* herdr.updateAgent(id, (a) => ({ ...a, status: "working" }))
      assert.include((yield* sessions.interrupt(id)).message, "interrupted")
      assert.deepStrictEqual((yield* herdr.callsTo("send")).at(-1)!.keys, ["esc"])
      yield* hook("stop", { status: "aborted" })
      yield* sessions.check(id)
      assert.strictEqual((yield* db.getSession(id))!.turnState, "interrupted")
      assert.strictEqual((yield* db.latestInbox(id, "result"))!.id, results)
    }).pipe(Effect.provide(testLayer({ plugins: [hookcliPlugin] }))),
  30_000,
)
