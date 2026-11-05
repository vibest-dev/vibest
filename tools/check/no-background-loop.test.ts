// .agents/rules/no-background-polling.md: vibestd runs no background loop that scans state on an interval. This greps
// packages/core/src and packages/server/src for the loop shapes; a hit fails unless the allowlist names it with a reason.
// The client, CLI, integration and runtime packages are not scanned: their reconnect loops are allowed.
import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const ROOTS = ["packages/core/src", "packages/server/src"]

/** Shapes that run on and on by themselves. `Effect.repeat` is counted below: it is one only without a bound. */
const PATTERNS = ["Effect.forever", "setInterval", "Stream.tick", "Effect.schedule("]
const REPEAT = "Effect.repeat"

/** The code without its comment lines (`//`, and the lines of a `/* … *\/` block). */
const code = (text: string) =>
  text
    .split("\n")
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .join("\n")

/**
 * `Effect.repeat` calls with no `until`, `while` or `times` in their arguments: `Effect.repeat(Schedule.…)`, the
 * data-first `Effect.repeat(effect, schedule)`, and `Effect.repeat({ schedule })`.
 */
const unboundedRepeats = (text: string) => {
  let hits = 0
  for (let at = text.indexOf(`${REPEAT}(`); at !== -1; at = text.indexOf(`${REPEAT}(`, at + 1)) {
    let depth = 0
    let end = at + REPEAT.length
    for (; end < text.length; end++) {
      if (text[end] === "(") depth++
      else if (text[end] === ")" && --depth === 0) break
    }
    if (!/\b(until|while|times)\b/.test(text.slice(at + REPEAT.length, end))) hits++
  }
  return hits
}

/** file → pattern → how many hits are allowed, and why. */
const ALLOWED: Record<string, Record<string, { readonly count: number; readonly reason: string }>> = {
  "packages/core/src/sessions.ts": {
    "Effect.forever": { count: 1, reason: "a blocking take from the delivered-rows queue (archive), not polling" },
  },
}

const files = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(dir, entry.name))
        : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
          ? [path.join(dir, entry.name)]
          : [],
    )

describe("no background loop", () => {
  it("core and server have no interval loop outside the allowlist", () => {
    const found: Array<string> = []
    for (const file of ROOTS.flatMap(files)) {
      const text = code(fs.readFileSync(file, "utf8"))
      for (const pattern of [...PATTERNS, REPEAT]) {
        const hits = pattern === REPEAT ? unboundedRepeats(text) : text.split(pattern).length - 1
        const allowed = ALLOWED[file]?.[pattern]?.count ?? 0
        if (hits !== allowed) found.push(`${file}: ${hits} × ${pattern} (allowed ${allowed})`)
      }
    }
    assert.deepStrictEqual(found, [])
  })

  it("counts each unbounded repeat shape, not a bounded one or a comment", () => {
    const sample = [
      "x.pipe(Effect.repeat(Schedule.spaced(TICK)))",
      "Effect.repeat(look(a, b), Schedule.fixed(1))",
      "Effect.repeat(look, { schedule: TICK })",
      "Effect.repeat({ until: (v) => v.ready, schedule: TICK })",
      "Effect.repeat(probe, {\n  while: (up) => !up,\n  schedule: TICK,\n})",
      "// Effect.repeat(Schedule.spaced(TICK))",
      " * Effect.forever",
    ].join("\n")
    assert.strictEqual(unboundedRepeats(code(sample)), 3)
    assert.isFalse(code(sample).includes("Effect.forever"))
  })
})
