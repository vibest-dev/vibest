import { assert, describe, it } from "@effect/vitest"
import type { Candidate } from "@vibest/core/plugin/sources"
import { keptBuiltins } from "@vibest/core/plugin/supervisor"
import { Effect, Predicate } from "effect"

const builtin = (id: string, optional = false): Candidate => ({
  source: `builtin:${id}`,
  revision: "-",
  options: {},
  plugin: { id, effect: () => Effect.void },
  ...(optional && { optional }),
})

const BUILTINS = [builtin("vibest.agent"), builtin("vibest.report-reminder", true)]

const kept = (...directives: ReadonlyArray<string | readonly [string, Record<string, string>]>) =>
  keptBuiltins(
    BUILTINS,
    directives.map((d) => {
      if (!Predicate.isString(d)) return { type: "add" as const, target: d[0], options: d[1] }

      return d.startsWith("-")
        ? { type: "remove" as const, target: d.slice(1) }
        : { type: "add" as const, target: d, options: {} }
    }),
  ).map((c) => [c.source, c.options])

describe("keptBuiltins", () => {
  it("keeps an optional builtin only when its last exact directive adds it, with that directive's options", () => {
    assert.deepStrictEqual(kept(), [["builtin:vibest.agent", {}]])
    assert.deepStrictEqual(kept("-vibest.report-reminder", ["vibest.report-reminder", { a: "1" }]), [
      ["builtin:vibest.agent", {}],
      ["builtin:vibest.report-reminder", { a: "1" }],
    ])
    assert.deepStrictEqual(kept("vibest.report-reminder", "-vibest.report-reminder"), [["builtin:vibest.agent", {}]])
    assert.deepStrictEqual(kept("vibest.report-reminder", "-*", "-vibest.*"), [
      ["builtin:vibest.agent", {}],
      ["builtin:vibest.report-reminder", {}],
    ])
    assert.deepStrictEqual(kept("-vibest.agent"), [])
  })
})
