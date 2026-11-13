import { assert, describe, it } from "@effect/vitest"
import { logfmt } from "@vibest/client/logging"
import { Cause, Effect, Logger } from "effect"

const capture = <A, E>(effect: Effect.Effect<A, E>) => {
  const lines: Array<string> = []
  const sink = Logger.layer([Logger.map(logfmt("r1"), (line) => void lines.push(line))])
  return effect.pipe(Effect.provide(sink), Effect.as(lines))
}

describe("logfmt logger", () => {
  it.effect("writes timestamp, level, run, then message fields", () =>
    Effect.gen(function* () {
      const [line] = yield* capture(Effect.logInfo("hello world", { "session.id": "s1" }))
      assert.match(line!, /^timestamp=\S+ level=INFO run=r1 message="hello world" session\.id=s1$/)
    }),
  )

  it.effect("a cyclic value is rendered as [Circular]", () =>
    Effect.gen(function* () {
      const cyclic: Record<string, unknown> = { name: "a" }
      cyclic.self = cyclic
      const [line] = yield* capture(Effect.logInfo({ cyclic }))
      assert.include(line!, "cyclic.self=[Circular]")
    }),
  )

  it.effect("a cause is one cause field with escaped newlines", () =>
    Effect.gen(function* () {
      const [line] = yield* capture(Effect.logError("failed", Cause.fail(new Error("boom\nsecond line"))))
      const cause = line!.slice(line!.indexOf(" cause="))
      assert.notInclude(line!, "\n")
      assert.include(cause, "boom")
      assert.include(cause, "\\n")
    }),
  )

  it.effect("nested annotations are flattened and values with spaces or quotes are escaped", () =>
    Effect.gen(function* () {
      const [line] = yield* capture(
        Effect.logInfo("x").pipe(Effect.annotateLogs({ plugin: { id: "a b", note: 'say "hi"' } })),
      )
      assert.include(line!, 'plugin.id="a b"')
      assert.include(line!, 'plugin.note="say \\"hi\\""')
    }),
  )

  it.effect("a span appears with its duration", () =>
    Effect.gen(function* () {
      const [line] = yield* capture(Effect.logInfo("x").pipe(Effect.withLogSpan("work")))
      assert.match(line!, / work=\d+/)
    }),
  )
})
