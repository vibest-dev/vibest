import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const ROOTS = ["packages/core/src", "packages/server/src", "packages/cli/src"]

const UNBOUNDED_LOOP_SHAPES = ["Effect.forever", "setInterval", "Stream.tick", "Effect.schedule("]
const REPEAT = "Effect.repeat"

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

const ALLOWED: Record<string, Record<string, { readonly count: number; readonly reason: string }>> = {
  "packages/cli/src/update-check.ts": {
    "Effect.repeat": { count: 1, reason: "the hourly look-up of the latest vibest, approved by the owner" },
  },
  "packages/core/src/plugin-supervisor.ts": {
    "Effect.forever": {
      count: 1,
      reason:
        "the plugin rescan every second, approved by the owner: macOS FSEvents drops change events under file-writing load and Bun fs.watch does not report the drop",
    },
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
      const text = fs.readFileSync(file, "utf8")
      for (const pattern of [...UNBOUNDED_LOOP_SHAPES, REPEAT]) {
        const hits = pattern === REPEAT ? unboundedRepeats(text) : text.split(pattern).length - 1
        const allowed = ALLOWED[file]?.[pattern]?.count ?? 0
        if (hits !== allowed) found.push(`${file}: ${hits} × ${pattern} (allowed ${allowed})`)
      }
    }
    assert.deepStrictEqual(found, [])
  })
})
