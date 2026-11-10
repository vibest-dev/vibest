import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

const V1_READERS = "packages/core/src/import/"

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

describe("no payload sql", () => {
  it("no query reads into a fact payload; only the v1 import reads v1 event data", () => {
    const found = sources("packages").filter(
      (file) => !file.startsWith(V1_READERS) && fs.readFileSync(file, "utf8").includes("json_extract"),
    )
    assert.deepStrictEqual(found, [])
  })
})
