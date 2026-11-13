import { assert, describe, it } from "@effect/vitest"
import * as Logging from "@vibest/client/logging"
import { Cause, ConfigProvider, Effect, Layer, Random } from "effect"
import { TestConsole } from "effect/testing"

const capture = (env: Record<string, string>, program: Effect.Effect<void>) =>
  Effect.gen(function* () {
    yield* program
    return (yield* TestConsole.errorLines).map(String)
  }).pipe(
    Effect.provide(Logging.layer),
    Random.withSeed("logging"),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
    Effect.provide(Layer.fresh(TestConsole.layer)),
  )

const all = Effect.gen(function* () {
  yield* Effect.logDebug("d")
  yield* Effect.logInfo("i")
  yield* Effect.logWarning("w")
  yield* Effect.logError("e")
})

const levelsFor = (env: Record<string, string>) =>
  capture(env, all).pipe(Effect.map((lines) => lines.map((line) => /level=(\w+)/.exec(line)?.[1])))

describe("Logging.layer", () => {
  it.effect("writes timestamp, level, run, then message fields", () =>
    Effect.gen(function* () {
      const [line] = yield* capture({}, Effect.logInfo("hello world", { "session.id": "s1" }))
      assert.match(line!, /^timestamp=\S+ level=INFO run=[0-9a-f]{8} message="hello world" session\.id=s1$/)
    }),
  )

  it.effect("the run id is the same on every record of one layer", () =>
    Effect.gen(function* () {
      const lines = yield* capture({}, Effect.logInfo("a").pipe(Effect.andThen(Effect.logInfo("b"))))
      const runs = lines.map((line) => /run=(\S+)/.exec(line)?.[1])
      assert.strictEqual(runs.length, 2)
      assert.strictEqual(runs[0], runs[1])
      assert.match(runs[0]!, /^[0-9a-f]{8}$/)
    }),
  )

  it.effect("a cyclic value is rendered as [Circular]", () =>
    Effect.gen(function* () {
      const cyclic: Record<string, unknown> = { name: "a" }
      cyclic.self = cyclic
      const [line] = yield* capture({}, Effect.logInfo({ cyclic }))
      assert.include(line!, "cyclic.self=[Circular]")
    }),
  )

  it.effect("a cause is one cause field with escaped newlines", () =>
    Effect.gen(function* () {
      const [line] = yield* capture({}, Effect.logError("failed", Cause.fail(new Error("boom\nsecond line"))))
      assert.notInclude(line!, "\n")
      assert.include(line!, "boom")
      assert.include(line!, "\\n")
    }),
  )

  it.effect("nested annotations are flattened and values with spaces or quotes are escaped", () =>
    Effect.gen(function* () {
      const [line] = yield* capture(
        {},
        Effect.logInfo("x").pipe(Effect.annotateLogs({ plugin: { id: "a b", note: 'say "hi"' } })),
      )
      assert.include(line!, 'plugin.id="a b"')
      assert.include(line!, 'plugin.note="say \\"hi\\""')
    }),
  )

  it.effect("a span appears with its duration", () =>
    Effect.gen(function* () {
      const [line] = yield* capture({}, Effect.logInfo("x").pipe(Effect.withLogSpan("work")))
      assert.match(line!, / work=\d+/)
    }),
  )

  it.effect("an unset or invalid VIBEST_LOG_LEVEL logs from Info", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* levelsFor({}), ["INFO", "WARN", "ERROR"])
      assert.deepStrictEqual(yield* levelsFor({ VIBEST_LOG_LEVEL: "loud" }), ["INFO", "WARN", "ERROR"])
    }),
  )

  it.effect("VIBEST_LOG_LEVEL sets the threshold in any case", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* levelsFor({ VIBEST_LOG_LEVEL: "DeBuG" }), ["DEBUG", "INFO", "WARN", "ERROR"])
      assert.deepStrictEqual(yield* levelsFor({ VIBEST_LOG_LEVEL: "warn" }), ["WARN", "ERROR"])
      assert.deepStrictEqual(yield* levelsFor({ VIBEST_LOG_LEVEL: "ERROR" }), ["ERROR"])
    }),
  )
})
