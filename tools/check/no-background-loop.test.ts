// .agents/rules/no-background-polling.md: vibestd runs no background loop that scans state on an interval. This greps
// packages/core/src and packages/server/src for the loop shapes; a hit fails unless the allowlist names it with a reason.
// The client, CLI, integration and runtime packages are not scanned: their reconnect loops are allowed.
import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const ROOTS = ["packages/core/src", "packages/server/src"]

/** `Effect.repeat(Schedule.…)` repeats with no `until`/`while`; a bounded `Effect.repeat({ until, schedule })` is fine. */
const PATTERNS = ["Effect.forever", "setInterval", "Effect.repeat(Schedule."]

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
      const text = fs.readFileSync(file, "utf8")
      for (const pattern of PATTERNS) {
        const hits = text.split(pattern).length - 1
        const allowed = ALLOWED[file]?.[pattern]?.count ?? 0
        if (hits !== allowed) found.push(`${file}: ${hits} × ${pattern} (allowed ${allowed})`)
      }
    }
    assert.deepStrictEqual(found, [])
  })
})
