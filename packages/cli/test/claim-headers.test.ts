import { assert, describe, it } from "@effect/vitest"
import { claimHeaders } from "@vibest/client/client"
import { REPOSITORY_HEADER, SESSION_HEADER } from "@vibest/protocol/protocol"
import { ConfigProvider, Effect, Logger, Path, References } from "effect"

describe("claim headers", () => {
  it.effect("a config source error is logged and the session claim still names the session", () =>
    Effect.gen(function* () {
      const logs: Array<string> = []
      const headers = yield* claimHeaders({
        _tag: "session",
        sessionId: "session-1",
        repositoryRoot: "/repo",
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.make(() =>
              Effect.fail(new ConfigProvider.SourceError({ message: "environment unreadable" })),
            ),
          ),
        ),
        Effect.provide(Logger.layer([Logger.make(({ message }) => void logs.push(String(message)))])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Path.layer),
        Effect.scoped,
      )
      assert.strictEqual(headers[SESSION_HEADER], "session-1")
      assert.strictEqual(headers[REPOSITORY_HEADER], "/repo")
      assert.isTrue(logs.some((line) => line.includes("environment unreadable")))
    }),
  )
})
