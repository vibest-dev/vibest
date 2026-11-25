import { assert, describe, it } from "@effect/vitest"
import { withHeaders } from "@vibest/client/unix-http"
import { type Db } from "@vibest/core/database/db"
import { Identity } from "@vibest/core/identity"
import { unwrapped } from "@vibest/core/replies"
import {
  callerPlugin,
  FakeGit,
  tempDirectory,
  until,
  untilVirtual,
  yieldToIo,
} from "@vibest/platform-bun/test/lib/fakes"
import {
  COMMIT,
  entryOn,
  inboxOf,
  Net,
  onB,
  outboxRows,
  REPOSITORY,
  repoStack,
  sendersTo,
  twoMachines,
} from "@vibest/platform-bun/test/lib/machines-fakes"
import { sessionHeaders } from "@vibest/protocol/protocol"
import { randomId } from "@vibest/schema/id"
import { PROMPT_MAX } from "@vibest/schema/machine"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"

import * as Platform from "#platform"

const peerB = repoStack()

const finish = (db: Db.Interface, session: string, message: string) =>
  db.inbox.insertInbox({ sessionId: session, message })

describe("vibest run --machine and remote sessions", () => {
  it.effect("List has every machine with its state; an unreachable one gives no sessions and says why", () =>
    Effect.gen(function* () {
      const { net, a, b, asEntry } = yield* twoMachines()
      const c = yield* repoStack(net)
      net.route("c-host", c.layout.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mc", target: "c-host" } }))

      const spawned = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {} },
        }),
      )

      yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mc", prompt: "y", callerEnv: {} },
        }),
      )
      net.fail("c-host", 255, "ssh: connect to host c-host port 22: Connection refused")
      yield* net.cutAll("c-host")
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[1]?.state === "unreachable")
      const listed = yield* asEntry(a.raw["server.session"]["session.list"]({ query: {} }))
      assert.deepStrictEqual(
        listed.sessions.filter((row) => row.machine !== undefined).map((row) => [row.id, row.machine]),
        [[spawned.id, "mb"]],
      )
      assert.deepStrictEqual(
        listed.machines.map((m) => [m.name, m.state]),
        [
          ["mb", "connected"],
          ["mc", "unreachable"],
        ],
      )
      assert.isUndefined(listed.machines[0]!.reason)
      assert.match(listed.machines[1]!.reason ?? "", /closed|refused/)
      assert.isNumber(listed.machines[1]!.since)
      assert.lengthOf(b.spawns, 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "B finds a checkout cloned with another URL form; A resolves its own ssh alias; NoProject names the URL",
    () =>
      Effect.gen(function* () {
        const net = new Net()
        const a = yield* repoStack(net, { sshHosts: { "gh-me": "GitHub.com" } }, "git@gh-me:o/r.git")
        const b = yield* repoStack(net, {}, "https://github.com/o/r")
        const other = yield* repoStack(net, {}, "https://github.com/o/other.git")
        net.route("b-host", b.layout.socket)
        net.route("o-host", other.layout.socket)
        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))
        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mo", target: "o-host" } }))
        yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) =>
          rows.every((row) => row.state === "connected"),
        )
        const { asEntry: here } = yield* entryOn(a)
        yield* here(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {} },
          }),
        )
        assert.lengthOf(b.spawns, 1)
        assert.strictEqual(b.spawns[0]!.root, b.directory)

        const missing = yield* Effect.flip(
          here(
            a.raw["server.session"]["session.spawn"]({
              payload: { agent: "general", machine: "mo", prompt: "x", callerEnv: {} },
            }),
          ),
        )

        assert.strictEqual(missing._tag, "NoProject")
        assert.include(missing.message, "has no checkout of git@gh-me:o/r.git")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("B with two checkouts of one repository takes the exact URL; identity is only the fallback", () =>
    Effect.gen(function* () {
      const net = new Net()
      const a = yield* repoStack(net, {}, "git@github.com:o/r.git")
      const b = yield* repoStack(net, {}, "git@github.com:o/r.git")
      const second = yield* tempDirectory("vibest-b-second-")
      yield* (yield* b.run(FakeGit)).repository(second, { ...REPOSITORY, origin: "https://github.com/o/r" })
      yield* b.db.project.createProject(second, [{ path: second, remote: "https://github.com/o/r" }])
      net.route("b-host", b.layout.socket)
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb", target: "b-host" } }))
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[0]?.state === "connected")
      const { asEntry: here } = yield* entryOn(a)
      yield* here(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {} },
        }),
      )
      assert.deepStrictEqual(
        b.spawns.map((spawn) => spawn.root),
        [b.directory],
      )
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("run --machine with no calling session is refused here without contacting B", () =>
    Effect.gen(function* () {
      const { a, b } = yield* twoMachines()

      const refused = yield* Effect.flip(
        a.cli(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {} },
          }),
        ),
      )

      assert.strictEqual(refused._tag, "NoCallingSession")
      assert.lengthOf(b.spawns, 0)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("run --machine by a session that is not the entry session reports to that session", () =>
    Effect.gen(function* () {
      const { a, b, asEntry } = yield* twoMachines()

      const local = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "x", callerEnv: {} } }),
      )

      const asSession = <A, E>(effect: Effect.Effect<A, E>) =>
        withHeaders(effect, sessionHeaders({ sessionId: local.id, projectId: a.project }))

      const spawned = yield* asSession(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "y", callerEnv: {} },
        }),
      )

      assert.deepStrictEqual(yield* b.db.session.creatorOf(onB(spawned.id)), {
        remote: a.id,
        session: local.id,
      })
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a session another machine started starts agents like any session and is their creator", () =>
    Effect.gen(function* () {
      const b = yield* peerB
      const call = yield* b.as(randomId(), "aproj")
      const { session } = yield* b.spawn(call)
      yield* withHeaders(
        b.raw["server.session"]["session.spawn"]({ payload: { agent: "general", prompt: "more", callerEnv: {} } }),
        sessionHeaders({ sessionId: session, projectId: b.project }),
      )
      assert.lengthOf(b.spawns, 2)
      assert.strictEqual(b.spawns[1]!.parentSessionId, session)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "a forwarded run starts a B session and nothing on A; its result arrives once as a notice; B's row is then deleted",
    () =>
      Effect.gen(function* () {
        const { a, b, entryId, asEntry } = yield* twoMachines()

        const spawned = yield* asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "do it there", callerEnv: {} },
          }),
        )

        assert.match(spawned.id, /^[0-9a-f-]{36}$/, "bare UUID id")
        assert.strictEqual(spawned.machine, "mb", "remote machine name")
        assert.isUndefined(yield* a.db.session.getSession(onB(spawned.id)), "A stores no session")
        assert.strictEqual(b.spawns[0]!.commit, COMMIT)
        yield* finish(b.db, onB(spawned.id), "General Agent completed")
        const [notice] = yield* until(a.run(inboxOf(entryId)), (rows) => rows.length === 1)
        assert.strictEqual(notice!.senderType, "vibest")
        assert.strictEqual(unwrapped(notice!.content), `${spawned.id.slice(0, 8)} (on mb): General Agent completed`)
        yield* until(b.run(outboxRows), (rows) => rows.length === 0)
        const shortId = spawned.id.slice(0, 8)

        const got = yield* asEntry(
          a.raw["server.session"]["session.get"]({ params: { id: shortId }, query: { machine: "mb" } }),
        )

        assert.strictEqual(got.id, spawned.id)
        assert.strictEqual(got.machine, "mb")
        assert.deepStrictEqual(
          yield* asEntry(
            a.raw["server.session"]["session.send"]({
              params: { id: shortId },
              payload: { machine: "mb", message: "more" },
            }),
          ),
          {
            id: spawned.id,
            machine: "mb",
          },
        )
        const entry = (yield* a.db.session.getSession(entryId))!
        assert.deepStrictEqual(yield* b.run(sendersTo(onB(spawned.id))), [
          {
            type: "agent",
            session: entryId,
            agent: entry.agent,
            title: entry.name,
            machine: (yield* b.db.remote.nameForRemote(a.id))!,
          },
        ])
        const listed = yield* asEntry(a.raw["server.session"]["session.list"]({ query: {} }))
        assert.deepInclude(
          listed.sessions.map((row) => [row.id, row.machine]),
          [spawned.id, "mb"],
        )
        assert.lengthOf(yield* a.run(inboxOf(entryId)), 1, "one notice")
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a send from B's session to its creator arrives on A with short <session-id> and <machine>", () =>
    Effect.gen(function* () {
      const { a, b, entryId, asEntry } = yield* twoMachines()

      const spawned = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "ask", callerEnv: {} },
        }),
      )

      const sentResult = yield* b.db.remote.sendToLinkedRemote(onB(spawned.id), entryId.slice(0, 8), "which branch?")
      assert.deepStrictEqual(sentResult, { sent: entryId })
      const [sent] = yield* until(a.run(inboxOf(entryId)), (rows) => rows.length === 1)
      assert.notStrictEqual(sent!.senderType, "vibest")
      assert.include(sent!.content, `<session-id>${spawned.id.slice(0, 8)}</session-id>\n<machine>mb</machine>`)
      assert.include(sent!.content, "which branch?")
      const asker = (yield* b.db.session.getSession(onB(spawned.id)))!
      assert.deepStrictEqual(yield* a.run(sendersTo(entryId)), [
        { type: "agent", session: onB(spawned.id), agent: "general", title: asker.name, machine: "mb" },
      ])
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "without --runtime A sends the caller's terminal runtime, else none and B chooses; --runtime wins; B lacking it fails clearly",
    () =>
      Effect.gen(function* () {
        const term = callerPlugin("term", { env: ["TERM_PANE"], terminal: () => Effect.succeed({ id: "p1" }) })
        const { net, a, b, asEntry } = yield* twoMachines({ a: { plugins: [term] } })
        yield* asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {} },
          }),
        )
        yield* asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: { TERM_PANE: "p1" } },
          }),
        )
        yield* asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: { TERM_PANE: "p1" }, runtime: "rex" },
          }),
        )
        assert.deepStrictEqual(
          b.spawns.map((spawn) => spawn.runtime),
          [undefined, "term", "rex"],
        )
        const c = yield* repoStack(net, { sessions: (s) => s })
        net.route("c-host", c.layout.socket)
        yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mc", target: "c-host" } }))
        yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[1]?.state === "connected")

        const failed = yield* Effect.flip(
          asEntry(
            a.raw["server.session"]["session.spawn"]({
              payload: {
                agent: "general",
                machine: "mc",
                prompt: "x",
                harness: "pi",
                callerEnv: { TERM_PANE: "p1" },
              },
            }),
          ),
        )

        assert.strictEqual(failed._tag, "NoRuntime")
        assert.include(failed.message, 'the runtime "term" is not loaded; loaded: herdr')
        assert.include(failed.message, (yield* c.run(Identity.Service)).name)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("the refused flags, an unknown machine and a machine that is not connected fail at once", () =>
    Effect.gen(function* () {
      const { net, a, asEntry } = yield* twoMachines()

      const run = (more: Partial<Parameters<(typeof a.raw)["server.session"]["session.spawn"]>[0]["payload"]>) =>
        Effect.flip(
          asEntry(
            a.raw["server.session"]["session.spawn"]({
              payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {}, ...more },
            }),
          ),
        )

      assert.include((yield* run({ env: { A: "1" } })).message, "--env is not sent to another machine")
      assert.include((yield* run({ runtimeSession: "s1" })).message, "--session is not sent to another machine")
      assert.include((yield* run({ prompt: "x".repeat(PROMPT_MAX + 1) })).message, "at most 1048576 bytes (1 MiB)")
      const big = yield* run({ prompt: "x".repeat(PROMPT_MAX + 1) })
      assert.strictEqual(big._tag, "PromptTooLarge", "B's error comes through unchanged")

      const nosuch = yield* Effect.flip(
        asEntry(
          a.raw["server.session"]["session.spawn"]({
            payload: { agent: "general", machine: "nosuch", prompt: "x", callerEnv: {} },
          }),
        ),
      )

      assert.strictEqual(nosuch._tag, "UnknownMachine")
      assert.strictEqual(nosuch.message, 'unknown machine "nosuch"; machines: mb')

      const missing = yield* Effect.flip(
        asEntry(a.raw["server.session"]["session.get"]({ params: { id: "deadbeef" }, query: { machine: "mb" } })),
      )

      assert.strictEqual(missing._tag, "NoSuchSession")
      assert.strictEqual(missing.message, "no session deadbeef", "B's error and message, no machine prefix")
      net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection refused")
      yield* net.cutAll("b-host")
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[0]?.state === "unreachable")
      const down = yield* run({})
      assert.strictEqual(down._tag, "MachineUnavailable")
      assert.include(down.message, "mb is unreachable: ")
      assert.match(down.message, /closed|refused/)

      const forwarded = yield* Effect.flip(
        asEntry(a.raw["server.session"]["session.get"]({ params: { id: "12345678" }, query: { machine: "mb" } })),
      )

      assert.strictEqual(forwarded._tag, "MachineUnavailable")
      assert.include(forwarded.message, "mb is unreachable")
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("a pipe cut after A's commit and before B got the ack gives one notice after reconnect", () =>
    Effect.gen(function* () {
      const cutOnce = { net: undefined as Net | undefined, done: false }

      const { net, a, b, entryId, asEntry } = yield* twoMachines({
        a: {
          db: (db) => ({
            ...db,
            remote: {
              ...db.remote,
              receiveRemoteItem: (item) =>
                db.remote
                  .receiveRemoteItem(item)
                  .pipe(
                    Effect.tap(() =>
                      cutOnce.done || cutOnce.net === undefined
                        ? Effect.void
                        : Effect.sync(() => (cutOnce.done = true)).pipe(Effect.andThen(cutOnce.net.cutAll("b-host"))),
                    ),
                  ),
            },
          }),
        },
      })

      cutOnce.net = net

      const spawned = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "x", callerEnv: {} },
        }),
      )

      yield* finish(b.db, onB(spawned.id), "once")
      yield* untilVirtual(b.run(outboxRows), (rows) => rows.length === 0)
      assert.isTrue(cutOnce.done)
      assert.lengthOf(yield* a.run(inboxOf(entryId)), 1)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect("results written while A is away, or after machine rm, arrive once when A connects again", () =>
    Effect.gen(function* () {
      const { net, a, b, entryId, asEntry } = yield* twoMachines()

      const first = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "one", callerEnv: {} },
        }),
      )

      const second = yield* asEntry(
        a.raw["server.session"]["session.spawn"]({
          payload: { agent: "general", machine: "mb", prompt: "two", callerEnv: {} },
        }),
      )

      net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection refused")
      yield* net.cutAll("b-host")
      yield* until(a.cli(a.raw["server.machine"]["machine.list"]({})), (rows) => rows[0]?.state === "unreachable")
      yield* finish(b.db, onB(first.id), "while away")
      net.route("b-host", b.layout.socket)
      yield* untilVirtual(a.run(inboxOf(entryId)), (rows) => rows.length === 1)
      yield* a.cli(a.raw["server.machine"]["machine.remove"]({ params: { name: "mb" } }))
      yield* finish(b.db, onB(second.id), "after rm")
      assert.lengthOf(yield* b.run(outboxRows), 1, "it waits on B")
      yield* a.cli(a.raw["server.machine"]["machine.add"]({ payload: { name: "mb2", target: "b-host" } }))
      const rows = yield* until(a.run(inboxOf(entryId)), (r) => r.length === 2)
      assert.strictEqual(unwrapped(rows[1]!.content), `${onB(second.id).slice(0, 8)} (on mb2): after rm`)
      yield* until(b.run(outboxRows), (r) => r.length === 0)
    }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )

  it.effect(
    "a silent connection is dropped by keepalive: pings go out every 5 s and 10 s without a frame ends it",
    () =>
      Effect.gen(function* () {
        const { net, a } = yield* twoMachines()
        net.fail("b-host", 255, "ssh: connect to host b-host port 22: Connection timed out")
        yield* Effect.forEach(net.routes.get("b-host")!.pipes, (p) => p.hold, { discard: true })
        const held = yield* Clock.currentTimeMillis
        yield* TestClock.adjust("14 seconds")
        yield* yieldToIo
        assert.strictEqual(
          (yield* a.cli(a.raw["server.machine"]["machine.list"]({})))[0]?.state,
          "connected",
          "not dropped before 15 s",
        )

        const [down] = yield* untilVirtual(
          a.cli(a.raw["server.machine"]["machine.list"]({})),
          (rows) => rows[0]?.state === "unreachable",
        )

        assert.include(down!.reason ?? "", "stopped answering")
        const after = (yield* Clock.currentTimeMillis) - held
        assert.isAtLeast(after, 15_000)
        assert.isBelow(after, 17_000)
      }).pipe(Effect.scoped, Effect.provide(Platform.services)),
  )
})
