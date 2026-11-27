import http from "node:http"

import { assert, describe } from "@effect/vitest"
import { Claim, incompatibleDaemon } from "@vibest/client/client"
import { SessionStore } from "@vibest/core/session/store"
import { Layout } from "@vibest/schema/layout"
import { PROTOCOL } from "@vibest/schema/version"
import { makeRepository, tempDirectory, until } from "@vibest/testkit/fakes"
import { asCli, asEntry, client, failureTag, test } from "@vibest/testkit/rpc-helpers"
import { Cause, Effect, Exit, type Schema } from "effect"

import { withVibest } from "../src/client.ts"
import { VERSION } from "../src/version.ts"

describe("vibest.sock legacy and edge cases", () => {
  test(
    "Get succeeds with reply.endedAt === null after an unresolved execution",
    Effect.gen(function* () {
      const sessionStore = yield* SessionStore.Service
      const repo = yield* makeRepository
      const raw = yield* client
      const cli = asCli(raw, repo)
      const spawner = yield* asEntry(raw, repo)

      const { id } = yield* spawner["server.session"]["session.spawn"]({
        payload: { agent: "general", callerEnv: {}, harness: "pi", prompt: "do it" },
      })

      yield* until(
        sessionStore.getSession(id),
        (row) => (row?.process?.placedAt ?? null) !== null && row?.openExecution !== null,
      )
      yield* sessionStore.endExecution(id, { outcome: "lost" }, undefined)
      const got = yield* cli["server.session"]["session.get"]({ params: { id }, query: {} })
      assert.strictEqual(got.reply?.status, "lost")
      assert.strictEqual(got.reply?.endedAt, null)
    }),
  )

  test(
    "a legacy Ping fails closed; a different package version does not",
    Effect.gen(function* () {
      const repo = yield* makeRepository

      const serve = (result: Schema.JsonObject) =>
        Effect.gen(function* () {
          const home = yield* tempDirectory("vibest-ping-")
          const layout = yield* Layout.make(home)

          const server = yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<http.Server>((resolve) => {
                  const listening = http.createServer((req, res) => {
                    if (req.method === "GET" && req.url === "/api/daemon/ping") {
                      const body = JSON.stringify(result)
                      res.writeHead(200, {
                        "content-type": "application/json",
                        "content-length": String(Buffer.byteLength(body)),
                      })
                      res.end(body)
                    } else {
                      res.writeHead(404).end()
                    }
                  })

                  listening.listen(layout.socket, () => resolve(listening))
                }),
            ),
            (listening) => Effect.sync(() => listening.close()),
          )

          return { layout, server }
        })

      const legacy = yield* serve({ version: "0.0.0", runtimes: [] })

      const refused = yield* Effect.exit(
        withVibest(Claim.cli({ repositoryRoot: repo }), () => Effect.die("must not call"), { start: false }).pipe(
          Effect.provideService(Layout, legacy.layout),
        ),
      )

      assert.strictEqual(failureTag(refused), "IncompatibleDaemon")
      assert.match(String(Exit.isFailure(refused) && Cause.pretty(refused.cause)), new RegExp(`protocol ${PROTOCOL}`))
      assert.match(String(Exit.isFailure(refused) && Cause.pretty(refused.cause)), /vibest daemon/)
      const said = String(Exit.isFailure(refused) && Cause.pretty(refused.cause))
      assert.include(
        said,
        "vibestd 0.0.0 (pid unknown, command unknown)",
        "a legacy pid is never guessed from vibestd.pid",
      )
      assert.include(said, `vibest ${VERSION} (`)
      assert.include(said, "kill -TERM <pid>")
      assert.include(said, "vibestd is older (0.0.0); run vibest update")
      const olderBuildWithoutRuntimes = yield* serve({ protocol: 2, version: VERSION, runtimeSessions: [] })

      const olderRefused = yield* Effect.exit(
        withVibest(Claim.cli({ repositoryRoot: repo }), () => Effect.die("must not call"), { start: false }).pipe(
          Effect.provideService(Layout, olderBuildWithoutRuntimes.layout),
        ),
      )

      assert.strictEqual(failureTag(olderRefused), "IncompatibleDaemon")
      const newer = yield* serve({ protocol: PROTOCOL, version: "9.9.9", runtimes: [] })
      assert.strictEqual(
        yield* withVibest(Claim.cli({ repositoryRoot: repo }), () => Effect.succeed("ok"), { start: false }).pipe(
          Effect.provideService(Layout, newer.layout),
        ),
        "ok",
      )
      assert.strictEqual(
        incompatibleDaemon(
          newer.layout.socket,
          { protocol: PROTOCOL, version: "9.9.9", runtimes: [] },
          { version: VERSION, command: ["vibest"] },
        ),
        undefined,
      )

      const olderClient = incompatibleDaemon(
        newer.layout.socket,
        { protocol: PROTOCOL + 1, version: "9.9.9", runtimes: [] },
        { version: VERSION, command: ["vibest"] },
      )?.message

      assert.include(
        olderClient,
        `older than vibestd 9.9.9 (pid unknown, command unknown) on ${newer.layout.socket}, which speaks protocol ${PROTOCOL + 1}. Run vibest update (again, if this was vibest update)`,
      )
      assert.include(olderClient, `To keep vibest ${VERSION} instead`)
      assert.include(olderClient, "kill -TERM <pid>")
      const needs = { capability: "harnesses", method: "harness.list" }
      const lacking = yield* serve({ protocol: PROTOCOL, version: "0.9.0", runtimes: [], capabilities: {} })

      const lackRefused = yield* Effect.exit(
        withVibest(Claim.cli({ repositoryRoot: repo }), () => Effect.die("must not call"), {
          start: false,
          needs,
        }).pipe(Effect.provideService(Layout, lacking.layout)),
      )

      assert.strictEqual(failureTag(lackRefused), "IncompatibleDaemon")
      const lackSaid = String(Exit.isFailure(lackRefused) && Cause.pretty(lackRefused.cause))
      assert.include(lackSaid, "vibestd is older (0.9.0); run vibest update")
      assert.include(lackSaid, "has no harness.list")
      assert.include(lackSaid, "vibest daemon restart")
      assert.strictEqual(
        yield* withVibest(Claim.cli({ repositoryRoot: repo }), () => Effect.succeed("no need"), {
          start: false,
        }).pipe(Effect.provideService(Layout, lacking.layout)),
        "no need",
      )

      const having = yield* serve({
        protocol: PROTOCOL,
        version: "0.9.0",
        runtimes: [],
        capabilities: { harnesses: true },
      })

      assert.strictEqual(
        yield* withVibest(Claim.cli({ repositoryRoot: repo }), () => Effect.succeed("ok"), {
          start: false,
          needs,
        }).pipe(Effect.provideService(Layout, having.layout)),
        "ok",
      )
    }),
  )
})
