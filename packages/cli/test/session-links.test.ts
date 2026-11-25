import { assert, describe } from "@effect/vitest"
import { Db } from "@vibest/core/database/db"
import { Placement } from "@vibest/core/session/placement"
import { authed, makeRepository } from "@vibest/platform-bun/test/lib/fakes"
import { asCli, asEntry, asSession, client, test } from "@vibest/platform-bun/test/lib/rpc-helpers"
import { session as draftSession } from "@vibest/platform-bun/test/lib/unit-helpers"
import { remoteHeaders } from "@vibest/protocol/protocol"
import { EdgeChain, EdgeDirected, EdgeMutual } from "@vibest/protocol/schemas"
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
      const opened = yield* cli["server.project"]["project.open"]({ payload: {} })
      const otherOpened = yield* otherCli["server.project"]["project.open"]({ payload: {} })
      const fromEntry = yield* asEntry(base, repo)
      const fromOtherEntry = yield* asEntry(base, otherRepo)

      const a = yield* fromEntry["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "a" },
      })

      const refA = { id: a.id }

      const b = yield* fromEntry["server.session"]["session.spawn"]({
        payload: {
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "b",
          from: [refA],
        },
      })

      const refB = { id: b.id }

      const c = yield* fromEntry["server.session"]["session.spawn"]({
        payload: {
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "c",
          to: [refA],
          with: [refB],
        },
      })

      const d = yield* fromEntry["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "d" },
      })

      const refD = { id: d.id }

      const otherChild = yield* fromOtherEntry["server.session"]["session.spawn"]({
        payload: {
          agent: "general",
          callerEnv: {},
          harness: "pi",
          prompt: "other",
        },
      })

      const fromA = yield* asSession(base, a.id)
      const fromB = yield* asSession(base, b.id)
      const fromC = yield* asSession(base, c.id)
      const fromD = yield* asSession(base, d.id)

      yield* fromA["server.session"]["session.send"]({ params: { id: b.id }, payload: { message: "a-to-b" } })
      assert.strictEqual(
        (yield* Effect.flip(
          fromB["server.session"]["session.send"]({ params: { id: a.id }, payload: { message: "b-to-a" } }),
        ))._tag,
        "Forbidden",
      )
      yield* fromC["server.session"]["session.send"]({ params: { id: a.id }, payload: { message: "c-to-a" } })
      assert.strictEqual(
        (yield* Effect.flip(
          fromA["server.session"]["session.send"]({ params: { id: c.id }, payload: { message: "a-to-c" } }),
        ))._tag,
        "Forbidden",
      )
      yield* fromC["server.session"]["session.send"]({ params: { id: b.id }, payload: { message: "c-to-b" } })
      yield* fromB["server.session"]["session.send"]({ params: { id: c.id }, payload: { message: "b-to-c" } })
      assert.strictEqual(
        (yield* Effect.flip(
          fromD["server.session"]["session.send"]({ params: { id: a.id }, payload: { message: "d-to-a" } }),
        ))._tag,
        "Forbidden",
      )

      const mutual = yield* cli["server.session"]["session.link"]({
        payload: { spec: EdgeMutual.make({ ids: [refA, refD] }) },
      })

      assert.deepStrictEqual(mutual.edges, [
        { from: refA, to: refD },
        { from: refD, to: refA },
      ])
      yield* fromD["server.session"]["session.send"]({ params: { id: a.id }, payload: { message: "d-to-a-now" } })
      yield* fromA["server.session"]["session.send"]({ params: { id: d.id }, payload: { message: "a-to-d-now" } })

      const idem = yield* cli["server.session"]["session.link"]({
        payload: { spec: EdgeMutual.make({ ids: [refA, refD] }) },
      })

      assert.deepStrictEqual(idem.edges, [
        { from: refA, to: refD },
        { from: refD, to: refA },
      ])

      const chain = yield* cli["server.session"]["session.link"]({
        payload: { spec: EdgeChain.make({ ids: [refD, refB, refA] }) },
      })

      assert.deepStrictEqual(chain.edges, [
        { from: refD, to: refB },
        { from: refB, to: refA },
      ])
      yield* fromB["server.session"]["session.send"]({ params: { id: a.id }, payload: { message: "b-to-a-chained" } })

      yield* cli["server.session"]["session.unlink"]({
        payload: { spec: EdgeDirected.make({ from: [refD], to: [refA] }) },
      })
      assert.strictEqual(
        (yield* Effect.flip(
          fromD["server.session"]["session.send"]({ params: { id: a.id }, payload: { message: "d-to-a-unlinked" } }),
        ))._tag,
        "Forbidden",
      )
      yield* fromA["server.session"]["session.send"]({
        params: { id: d.id },
        payload: { message: "a-to-d-still-linked" },
      })

      const selfLoop = yield* Effect.flip(
        cli["server.session"]["session.link"]({ payload: { spec: EdgeDirected.make({ from: [refA], to: [refA] }) } }),
      )

      assert.strictEqual(selfLoop._tag, "Forbidden")

      assert.notStrictEqual(opened.projectId, otherOpened.projectId)

      const crossProject = yield* Effect.flip(
        cli["server.session"]["session.link"]({
          payload: { spec: EdgeDirected.make({ from: [refA], to: [{ id: otherChild.id }] }) },
        }),
      )

      assert.strictEqual(crossProject._tag, "Forbidden")

      const remoteLinks = yield* Effect.flip(
        fromEntry["server.session"]["session.spawn"]({
          payload: {
            agent: "general",
            callerEnv: {},
            harness: "pi",
            prompt: "remote",
            machine: "box",
            with: [refA],
          },
        }),
      )

      assert.strictEqual(remoteLinks._tag, "MachineFailed")
      assert.notInclude(remoteLinks.message, "not available with --machine")

      const remote = authed(base, remoteHeaders("remote-1", opened.projectId))

      const remoteLink = yield* Effect.flip(
        remote["server.session"]["session.link"]({
          payload: { spec: EdgeDirected.make({ from: [refA], to: [refB] }) },
        }),
      )

      assert.strictEqual(remoteLink._tag, "InvalidCaller")

      const remoteUnlink = yield* Effect.flip(
        remote["server.session"]["session.unlink"]({
          payload: { spec: EdgeDirected.make({ from: [refA], to: [refB] }) },
        }),
      )

      assert.strictEqual(remoteUnlink._tag, "InvalidCaller")

      const singleUnlink = yield* Effect.flip(
        cli["server.session"]["session.unlink"]({ payload: { spec: EdgeMutual.make({ ids: [refA] }) } }),
      )

      assert.strictEqual(singleUnlink._tag, "Forbidden")
      assert.notInclude(singleUnlink.message, "to link")

      const db = yield* Db.Service
      const placement = yield* Placement.Service
      const rowA = (yield* db.session.getSession(a.id))!
      const entryId = (yield* db.session.sessionParents([a.id])).get(a.id)!

      const promptBefore = yield* placement.systemPromptOf(rowA)
      assert.include(promptBefore, `vibest send ${entryId.slice(0, 8)}`)

      yield* cli["server.session"]["session.unlink"]({
        payload: { spec: EdgeDirected.make({ from: [refA], to: [{ id: entryId }] }) },
      })

      const refusedParent = yield* Effect.flip(
        fromA["server.session"]["session.send"]({
          params: { id: entryId },
          payload: { message: "to-unlinked-parent" },
        }),
      )

      assert.strictEqual(refusedParent._tag, "Forbidden")
      assert.notInclude(refusedParent.message, `you may send to ${entryId}`)

      const promptAfter = yield* placement.systemPromptOf(rowA)
      assert.notInclude(promptAfter, `vibest send ${entryId.slice(0, 8)}`)
      assert.include(promptAfter, "not linked to message it directly")

      const remoteCreatorId = "99999999-9999-4999-8999-999999999999"
      const remoteSessionId = "88888888-8888-4888-8888-888888888888"

      yield* db.session.insertSession(draftSession(remoteSessionId), opened.projectId, {
        cwd: repo,
        task: "remote task",
        origin: { remote: "remote-1", project: "77777777-7777-4777-8777-777777777777", reportTo: remoteCreatorId },
      })

      const remoteRow = (yield* db.session.getSession(remoteSessionId))!
      const remotePrompt = yield* placement.systemPromptOf(remoteRow)
      assert.include(remotePrompt, `vibest send ${remoteCreatorId.slice(0, 8)}`)
      assert.notInclude(remotePrompt, "not linked to message it directly")

      yield* db.session.unlinkSessions([{ from: remoteSessionId, to: remoteCreatorId, remote: "remote-1" }])
      const remotePromptUnlinked = yield* placement.systemPromptOf(remoteRow)
      assert.notInclude(remotePromptUnlinked, `vibest send ${remoteCreatorId.slice(0, 8)}`)
      assert.include(remotePromptUnlinked, "not linked to message it directly")
    }),
  )
})
