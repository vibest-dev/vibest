import { assert, describe } from "@effect/vitest"
import { makeRepository } from "@vibest/platform-bun/test/lib/fakes"
import { asCli, asEntry, asSession, client, test } from "@vibest/platform-bun/test/lib/rpc-helpers"
import { EdgeChain, EdgeDirected, EdgeMutual } from "@vibest/protocol/rpc"
import { Effect } from "effect"

describe("Session graph links RPC", () => {
  test(
    "Spawn --from/--to/--with and Session.Link / Session.Unlink govern directed messaging and reject invalid edges",
    Effect.gen(function* () {
      const base = yield* client
      const repo = yield* makeRepository
      const otherRepo = yield* makeRepository
      const cli = asCli(base, repo)
      const otherCli = asCli(base, otherRepo)
      const opened = yield* cli["Project.Open"]({})
      const otherOpened = yield* otherCli["Project.Open"]({})
      const fromEntry = yield* asEntry(base, repo)
      const fromOtherEntry = yield* asEntry(base, otherRepo)

      const a = yield* fromEntry.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "a" })

      const b = yield* fromEntry.Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "b",
        from: [a.id],
      })

      const c = yield* fromEntry.Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "c",
        to: [a.id],
        with: [b.id],
      })

      const d = yield* fromEntry.Spawn({ agent: "general", callerEnv: {}, harness: "pi", prompt: "d" })

      const otherChild = yield* fromOtherEntry.Spawn({
        agent: "general",
        callerEnv: {},
        harness: "pi",
        prompt: "other",
      })

      const fromA = yield* asSession(base, a.id)
      const fromB = yield* asSession(base, b.id)
      const fromC = yield* asSession(base, c.id)
      const fromD = yield* asSession(base, d.id)

      yield* fromA.Send({ id: b.id, message: "a-to-b" })
      assert.strictEqual((yield* Effect.flip(fromB.Send({ id: a.id, message: "b-to-a" })))._tag, "Forbidden")
      yield* fromC.Send({ id: a.id, message: "c-to-a" })
      assert.strictEqual((yield* Effect.flip(fromA.Send({ id: c.id, message: "a-to-c" })))._tag, "Forbidden")
      yield* fromC.Send({ id: b.id, message: "c-to-b" })
      yield* fromB.Send({ id: c.id, message: "b-to-c" })
      assert.strictEqual((yield* Effect.flip(fromD.Send({ id: a.id, message: "d-to-a" })))._tag, "Forbidden")

      const mutual = yield* cli["Session.Link"]({ spec: EdgeMutual.make({ ids: [a.id, d.id] }) })
      assert.deepStrictEqual(mutual.edges, [
        { from: a.id, to: d.id },
        { from: d.id, to: a.id },
      ])
      yield* fromD.Send({ id: a.id, message: "d-to-a-now" })
      yield* fromA.Send({ id: d.id, message: "a-to-d-now" })

      const idem = yield* cli["Session.Link"]({ spec: EdgeMutual.make({ ids: [a.id, d.id] }) })
      assert.deepStrictEqual(idem.edges, [
        { from: a.id, to: d.id },
        { from: d.id, to: a.id },
      ])

      const chain = yield* cli["Session.Link"]({ spec: EdgeChain.make({ ids: [d.id, b.id, a.id] }) })
      assert.deepStrictEqual(chain.edges, [
        { from: d.id, to: b.id },
        { from: b.id, to: a.id },
      ])
      yield* fromB.Send({ id: a.id, message: "b-to-a-chained" })

      yield* cli["Session.Unlink"]({ spec: EdgeDirected.make({ from: [d.id], to: [a.id] }) })
      assert.strictEqual((yield* Effect.flip(fromD.Send({ id: a.id, message: "d-to-a-unlinked" })))._tag, "Forbidden")
      yield* fromA.Send({ id: d.id, message: "a-to-d-still-linked" })

      const selfLoop = yield* Effect.flip(
        cli["Session.Link"]({ spec: EdgeDirected.make({ from: [a.id], to: [a.id] }) }),
      )

      assert.strictEqual(selfLoop._tag, "Forbidden")

      assert.notStrictEqual(opened.projectId, otherOpened.projectId)

      const crossProject = yield* Effect.flip(
        cli["Session.Link"]({ spec: EdgeDirected.make({ from: [a.id], to: [otherChild.id] }) }),
      )

      assert.strictEqual(crossProject._tag, "Forbidden")

      const remoteLinks = yield* Effect.flip(
        fromEntry.Spawn({
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "remote",
          machine: "box",
          with: [a.id],
        }),
      )

      assert.strictEqual(remoteLinks._tag, "MachineFailed")
    }),
  )
})
