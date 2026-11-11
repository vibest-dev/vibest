import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const LEDGER = ["packages/core/src/journal.ts", "packages/core/src/db-schema.ts"]

const EVENT_READ = /\b(FROM|JOIN) event\b/
const POSITION = /\bposition\b/

const sources = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.name === "node_modules" || entry.name === "dist" || entry.name === "generated"
        ? []
        : entry.isDirectory()
          ? sources(path.join(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && dir.split(path.sep).includes("src")
            ? [path.join(dir, entry.name)]
            : [],
    )

describe("event reads", () => {
  it("only the journal reads the event table and its local position", () => {
    const found = sources("packages").filter((file) => {
      if (LEDGER.includes(file)) return false
      const text = fs.readFileSync(file, "utf8")
      return EVENT_READ.test(text) || POSITION.test(text)
    })
    assert.deepStrictEqual(found, [])
  })
})
