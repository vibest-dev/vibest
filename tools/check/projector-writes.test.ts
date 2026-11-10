import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const WRITES = /INSERT INTO|UPDATE |DELETE FROM|sql\.insert\(|sql\.update\(/g

const WRITERS = [
  "packages/core/src/journal.ts",
  "packages/core/src/projectors.ts",
  "packages/core/src/db-schema.ts",
  "packages/core/src/import/",
  "packages/core/src/database/",
]

const ALLOWED: Record<string, { readonly count: number; readonly reason: string }> = {
  "packages/core/src/db.ts": {
    count: 1,
    reason:
      "the empty write at open takes the write lock, so two processes opening an empty database wait for each other",
  },
}

const sources = (dir: string): Array<string> =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) =>
      entry.name === "node_modules" || entry.name === "dist"
        ? []
        : entry.isDirectory()
          ? sources(path.join(dir, entry.name))
          : entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && dir.split(path.sep).includes("src")
            ? [path.join(dir, entry.name)]
            : [],
    )

describe("projector writes", () => {
  it("only the journal, the projectors, the schema, migrations and the import write tables", () => {
    const found: Array<string> = []
    for (const file of sources("packages")) {
      if (WRITERS.some((writer) => file.startsWith(writer))) continue
      const hits = fs.readFileSync(file, "utf8").match(WRITES)?.length ?? 0
      const allowed = ALLOWED[file]?.count ?? 0
      if (hits !== allowed) found.push(`${file}: ${hits} writes (allowed ${allowed})`)
    }
    assert.deepStrictEqual(found, [])
  })
})
