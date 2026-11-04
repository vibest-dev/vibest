// A second product on the engine: composed only from packages/core, the plugin API, a fake runtime and a fake
// harness, with no import of packages/vibest (and no server). It fills the engine's ports itself (a plain directory
// per session, its own system prompt, no placement policy) and runs two orchestrations: two peers that message each
// other, and a gather of two workers' results into one message.
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { BunServices } from "@effect/platform-bun"
import { assert, describe, it } from "@effect/vitest"
import { Actions } from "@vibest/core/actions"
import { Agents } from "@vibest/core/agents"
import { mayManage } from "@vibest/core/capabilities"
import { Db } from "@vibest/core/db"
import { Drain } from "@vibest/core/drain"
import { Groups } from "@vibest/core/groups"
import { Harness, Harnesses } from "@vibest/core/harness"
import * as BuiltinHarnesses from "@vibest/core/harnesses"
import { Inbox } from "@vibest/core/inbox"
import * as MemoryStore from "@vibest/core/memory-store"
import { Layout } from "@vibest/core/paths"
import { PlacementPolicy } from "@vibest/core/placement"
import { Plugins } from "@vibest/core/plugins"
import { Processes } from "@vibest/core/processes"
import { Restarting } from "@vibest/core/restarting"
import { Runtimes, registry } from "@vibest/core/runtimes"
import { Sessions } from "@vibest/core/sessions"
import { Subscriptions } from "@vibest/core/subscriptions/service"
import { SessionPrompt } from "@vibest/core/system-prompt"
import { TurnEnds } from "@vibest/core/turn-ends"
import { Workspace, WorkspaceRefused } from "@vibest/core/workspace"
import { ActionRefused, Plugin } from "@vibest/plugin"
import type { Harness as H } from "@vibest/plugin"
import { Clock, ConfigProvider, Effect, Layer, Ref, type Scope } from "effect"
import { TestClock } from "effect/testing"

import { FakeRuntime } from "./fake-runtime.ts"

/** The fake harness: typed delivery, its integration reports every turn (the test plays it). */
/** The product's one grouping of sessions (the engine's scope). */
const SCOPE = "tiny"

const bot: H.HarnessAdapter = {
  id: "bot",
  binary: "bot",
  conversation: "reported",
  systemPromptInPrompt: false,
  interruptKey: "esc",
  delivery: "type",
  reportsState: true,
  checkProvider: () => undefined,
  launchArgs: (i) => ["--prompt-file", i.systemPromptFile],
  models: { args: () => [], answer: () => [] },
}

/** The product plugin's own send, for the tests to act through. */
let sendAs: (as: string, to: string, message: string) => Effect.Effect<unknown, ActionRefused> = () => Effect.void

/** This product's whole policy, as one plugin: its harness, a peer role, and a gather of a lead's workers. */
const product = Plugin.define({
  id: "tiny-product",
  effect: (context) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      yield* context.harness.register(bot)
      // Its one runtime is the fake one.
      yield* context.agent.hook("start.before", (event) =>
        Effect.sync(() => {
          event.runtime ??= "herdr"
        }),
      )
      yield* context.agent.define({ name: "peer", tools: "full", can: { spawn: false, message: "project" } })
      yield* context.agent.define({ name: "solo", tools: "full", can: { spawn: false, message: "report-only" } })
      sendAs = (as, to, message) => context.session.send({ as, to, message })
      /** worker id -> its gather: the lead and the outputs so far. */
      const gathers = new Map<
        string,
        { readonly lead: string; readonly size: number; readonly outputs: Array<string> }
      >()
      yield* context.agent.hook("result", (event) =>
        Effect.gen(function* () {
          const fan = /^gather: (\w{8}) (\w{8}) into (\w{8})$/m.exec(event.output)
          if (fan) {
            const group = { lead: fan[3]!, size: 2, outputs: [] as Array<string> }
            gathers.set(fan[1]!, group)
            gathers.set(fan[2]!, group)
            return
          }
          const group = gathers.get(event.sessionId)
          if (!group) return
          // A worker's own result reaches no one; the lead gets them all as one message once each is in.
          event.recipients = []
          group.outputs.push(event.output)
          if (group.outputs.length < group.size) return
          yield* Effect.forkIn(
            context.session
              .send({ as: group.lead, to: group.lead, message: `gathered:\n${group.outputs.join("\n")}` })
              .pipe(Effect.catchTag("ActionRefused", () => Effect.void)),
            scope,
          )
        }),
      )
    }),
})

/** The engine's ports, filled by this product: a plain directory per session, no git, no placement policy. */
const ports = (base: string) =>
  Layer.mergeAll(
    Layer.succeed(
      Workspace,
      Workspace.of({
        project: (directory) => Effect.succeed({ root: directory, key: directory }),
        repositories: () => Effect.succeed(undefined),
        mainCheckout: (directory) => Effect.succeed(directory),
        reserve: () =>
          Effect.tryPromise({
            try: () => fs.mkdtemp(path.join(base, "s-")),
            catch: (e) => new WorkspaceRefused({ message: String(e) }),
          }),
        prepare: () => Effect.void,
        // No shared files directory for its sessions: nothing in their environment.
        files: () => Effect.succeed({ directory: base, env: {} }),
        state: () => Effect.succeed(undefined),
        repositoryStates: () => Effect.succeed(undefined),
        release: () => Effect.succeed({ worktree: "kept", reason: "a plain directory", shared: false, branch: null }),
      }),
    ),
    Layer.succeed(SessionPrompt, SessionPrompt.of({ text: ({ id }) => Effect.succeed(`You are ${id}.`) })),
    Layer.succeed(
      PlacementPolicy,
      PlacementPolicy.of({
        near: () => Effect.succeed(undefined),
        root: (_session, cwd) => Effect.succeed(cwd),
        labelRoot: (_session, cwd) => Effect.succeed(cwd),
        labels: () => Effect.succeed({}),
        alone: () => Effect.succeed(undefined),
      }),
    ),
  )

const engine = Layer.unwrap(
  Effect.gen(function* () {
    const base = yield* Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "engine-only-")))
    const runtime = Layer.effect(
      Runtimes,
      Effect.flatMap(FakeRuntime, (fake) => registry([fake.runtime])),
    )
    // The integration's ready report once the harness is up, and its turn starts.
    const integration = Layer.effectDiscard(
      Effect.gen(function* () {
        const fake = yield* FakeRuntime
        const db = yield* Db
        const sessions = yield* Sessions
        yield* Ref.set(fake.onStarted, (id) =>
          Clock.currentTimeMillis.pipe(Effect.flatMap((at) => db.patchLive(id, { ready: at, pid: 4242 }))),
        )
        yield* Ref.set(fake.onActivity, (id, status) =>
          sessions.activity(id, status === "working" ? "working" : { blocked: "permission" }),
        )
        // The product's actions: a plugin's send is checked with the engine's capability rule (`mayManage`), then sent.
        const refused = (e: { readonly message: string }) => new ActionRefused({ reason: e.message })
        const agents = yield* Agents
        const groups = yield* Groups
        yield* (yield* Actions).install({
          send: ({ as, to, message }) =>
            Effect.gen(function* () {
              const from = yield* db.getSession(as)
              const target = yield* db.getSession(to)
              if (!from || !target) return yield* new ActionRefused({ reason: "no such session" })
              const verdict = yield* mayManage(
                { _tag: "Session", sessionId: as, group: from.scope, message: agents.of(from.agent).can.message },
                { id: to, group: target.scope },
                { descends: db.descends, shared: groups.shared },
              )
              if (verdict !== "allowed")
                return yield* new ActionRefused({ reason: `${as} may not message ${to}: ${verdict}` })
              yield* sessions.send(to, message, as).pipe(Effect.mapError(refused))
            }),
          spawn: () => Effect.fail(new ActionRefused({ reason: "this product starts sessions itself" })),
          archive: ({ id }) => sessions.archiveSettled(id).pipe(Effect.mapError(refused)),
          notice: ({ about, kind, text, to }) => sessions.notice(about, kind, text, to).pipe(Effect.mapError(refused)),
        })
      }),
    )
    const sessions = Layer.effect(Sessions, Sessions.make({ maxSessions: undefined })).pipe(
      Layer.provideMerge(
        Layer.effect(
          Plugins,
          Plugins.make([{ source: "test:tiny", revision: "-", options: {}, plugin: product }]),
        ).pipe(Layer.provideMerge(Subscriptions.layer)),
      ),
      Layer.provideMerge(Inbox.layer),
      Layer.provideMerge(ports(base)),
      Layer.provideMerge(MemoryStore.layer),
      Layer.provideMerge(runtime),
      Layer.provideMerge(
        Layer.succeed(Harness, {
          available: () => Effect.succeed(true),
          plugin: () => Effect.succeed(""),
          models: () => Effect.succeed([]),
        }),
      ),
      Layer.provideMerge(BuiltinHarnesses.layer),
      Layer.provideMerge(Agents.layer),
      Layer.provideMerge(Actions.layer),
      Layer.provideMerge(Groups.layer),
      Layer.provideMerge(
        Layer.succeed(Processes, {
          liveness: () => Effect.succeed("alive"),
          terminate: () => Effect.succeed("sent"),
          cwdUsers: () => Effect.succeed([]),
        }),
      ),
      Layer.provideMerge(Layer.effect(Layout, Layout.make(path.join(base, "home")))),
      Layer.provideMerge(
        ConfigProvider.layerAdd(ConfigProvider.fromUnknown({ TMPDIR: path.join(base, "tmp") }), { asPrimary: true }),
      ),
      Layer.provideMerge(Drain.layer),
      Layer.provideMerge(Restarting.layer),
      Layer.provideMerge(TurnEnds.layer),
      Layer.provideMerge(BunServices.layer),
    )
    return integration.pipe(Layer.provideMerge(sessions), Layer.provideMerge(FakeRuntime.layer()))
  }),
)

const test = <E>(
  name: string,
  program: Effect.Effect<void, E, Sessions | Db | FakeRuntime | Harnesses | Scope.Scope>,
) => it.effect(name, () => program.pipe(Effect.provide(engine)), 30_000)

/** `read` until `ok` holds, a real 10 ms between tries (the engine's own clock is the test clock). */
const until = <A, R>(read: Effect.Effect<A, never, R>, ok: (a: A) => boolean) =>
  Effect.gen(function* () {
    for (let i = 0; i < 300; i++) {
      const a = yield* read
      if (ok(a)) return a
      yield* TestClock.withLive(Effect.sleep("10 millis"))
    }
    return yield* Effect.die(new Error(`until: gave up on ${JSON.stringify(yield* read).slice(0, 600)}`))
  })

/** Start a session of `agent` on `prompt` in this product's one group, as the user. */
const start = (prompt: string, agent?: string) =>
  Effect.gen(function* () {
    const { id } = yield* (yield* Sessions).spawn({
      machine: { id: "local" },
      root: "/tiny",
      key: SCOPE,
      name: prompt.slice(0, 20),
      prompt,
      harness: "bot",
      ...(agent === undefined ? {} : { agent }),
    })
    yield* opened(id)
    return id
  })

/** `id`'s turn opens on what was typed into it: its integration reports the turn start (`turn.start`). */
const opened = (id: string, typedBefore = 0) =>
  Effect.gen(function* () {
    yield* until(typed(id), (texts) => texts.length > typedBefore)
    yield* (yield* Sessions).activity(id, "working")
    yield* until((yield* Db).getSession(id), (s) => s?.turnState === "open")
  })

/** The fake harness answers `text`: its integration reports the turn end, the runtime shows it idle. */
const answer = (id: string, text: string) =>
  Effect.gen(function* () {
    const sessions = yield* Sessions
    yield* sessions.turnEnded(id, {
      harness: "bot",
      at: (yield* Clock.currentTimeMillis) + 1,
      text,
      error: undefined,
      interrupted: false,
    })
    yield* (yield* FakeRuntime).endTurn(id)
    yield* sessions.check(id)
    yield* until((yield* Db).getSession(id), (s) => s?.turnState !== "open")
  })

/** The results of `about` waiting for the user (the rows with no session to go to), through the storage port. */
const toUser = (about: string) =>
  Effect.flatMap(Db, (db) => db.userInbox(SCOPE, false)).pipe(
    Effect.map((rows) => rows.filter((r) => r.kind === "result" && r.sessionId === about).map((r) => r.message)),
  )

/** The texts typed into `id`'s terminal, in order. */
const typed = (id: string) =>
  Effect.gen(function* () {
    const fake = yield* FakeRuntime
    const terminal = yield* fake.terminalOf(id)
    return (yield* fake.callsTo("send")).filter((c) => c.terminal === terminal?.id).map((c) => c.text ?? "")
  })

describe("an engine-only product", () => {
  test(
    "two peers: a message from one is delivered to the other, and the answer goes back to the sender",
    Effect.gen(function* () {
      const a = yield* start("write the parser", "peer")
      const b = yield* start("write the tests", "peer")
      yield* answer(a, "parser done")
      yield* answer(b, "tests done")
      // Nobody else: each first result is the user's.
      assert.lengthOf(yield* toUser(a), 1)

      const before = (yield* typed(b)).length
      yield* (yield* Sessions).send(b, "do the tests cover empty input?", a)
      yield* opened(b, before)
      assert.include((yield* typed(b)).at(-1), "do the tests cover empty input?")
      yield* answer(b, "yes, they do")
      // B's answer is A's, not the user's: A's turn on it opens, and answers no one.
      assert.lengthOf(yield* toUser(b), 1)
      yield* opened(a, 1)
      assert.include((yield* typed(a)).at(-1), "yes, they do")
      yield* answer(a, "noted")

      // Through the plugin API, checked by the engine's capability rule: a peer may message, a report-only role not.
      const solo = yield* start("work alone", "solo")
      yield* answer(solo, "alone")
      const refusal = yield* Effect.flip(sendAs(solo, a, "hello"))
      assert.include(refusal.reason, "reportOnly")
      const beforeA = (yield* typed(a)).length
      yield* sendAs(b, a, "thanks for asking")
      yield* opened(a, beforeA)
      assert.include((yield* typed(a)).at(-1), "thanks for asking")
    }),
  )

  test(
    "a gather: two workers' results reach the lead as one message, sent by the product's plugin",
    Effect.gen(function* () {
      const lead = yield* start("lead the work", "peer")
      const w1 = yield* start("part one")
      const w2 = yield* start("part two")
      yield* answer(lead, `gather: ${w1} ${w2} into ${lead}`)
      const before = (yield* typed(lead)).length
      yield* answer(w1, "one is done")
      yield* answer(w2, "two is done")
      // A worker's own result reaches no one: kept as its own, dropped (the gather sends the lead one message).
      assert.strictEqual((yield* (yield* Db).latestInbox(w1, "result"))?.status, "dropped")
      assert.deepStrictEqual(yield* toUser(w1), [])
      yield* opened(lead, before)
      const last = (yield* typed(lead)).at(-1)!
      assert.include(last, "gathered:")
      assert.include(last, "one is done")
      assert.include(last, "two is done")
    }),
  )
})
