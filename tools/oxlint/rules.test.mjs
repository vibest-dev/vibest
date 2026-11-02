// Runs the real oxlint with the repository config over fixture files, so the plugin rules are tested as oxlint loads them.
import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

import { describe, expect, it } from "vitest"

const root = url.fileURLToPath(new URL("../..", import.meta.url))

// Lints one fixture and returns its diagnostics as "line code".
const lint = (source) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibest-oxlint-"))
  try {
    fs.writeFileSync(path.join(dir, "fixture.ts"), source)
    const run = childProcess.spawnSync(
      path.join(root, "node_modules/.bin/oxlint"),
      ["-c", path.join(root, ".oxlintrc.json"), "-f", "json", dir],
      { encoding: "utf8" },
    )
    return JSON.parse(run.stdout)
      .diagnostics.map((d) => `${d.labels[0].span.line} ${d.code}`)
      .sort()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

describe("node-import-style", () => {
  it("accepts default imports under their canonical names, and type-only imports", () => {
    expect(
      lint(`import childProcess from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import type { Stats } from "node:fs"
import { type Dirent } from "node:fs"
export type { Stats } from "node:fs"
export const all = [childProcess, fs, fsPromises] as unknown as [Stats, Dirent]
`),
    ).toEqual([])
  })

  it("rejects named and namespace imports", () => {
    expect(
      lint(`import { readFileSync } from "node:fs"
import * as path from "node:path"
export const all = [readFileSync, path]
`),
    ).toEqual(["1 vibest(node-import-style)", "2 vibest(node-import-style)"])
  })

  it("rejects ad-hoc names, and the short name for a subpath when its parent is imported too", () => {
    expect(
      lint(`import nodePath from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"
export const all = [nodePath, fs, fsp]
`),
    ).toEqual(["1 vibest(node-import-style)", "3 vibest(node-import-style)"])
  })

  it("rejects re-exports from builtins", () => {
    expect(
      lint(`export { readFileSync } from "node:fs"
export * from "node:path"
`),
    ).toEqual(["1 vibest(node-import-style)", "2 vibest(node-import-style)"])
  })
})

describe("no-restricted-disable", () => {
  it.each([
    "unicorn/prefer-node-protocol",
    "prefer-node-protocol",
    "node/prefer-node-protocol",
    "eslint-plugin-unicorn/prefer-node-protocol",
  ])("refuses disabling %s", (rule) => {
    expect(
      lint(`// oxlint-disable-next-line ${rule}
import os from "os"
export const cpus = os.cpus()
`),
    ).toContain("1 vibest(no-restricted-disable)")
  })

  it("refuses a blanket disable", () => {
    expect(lint(`// eslint-disable\nexport const one = 1\n`)).toEqual(["1 vibest(no-restricted-disable)"])
  })

  it("allows disabling other rules", () => {
    expect(lint(`// oxlint-disable-next-line eslint/no-unused-vars -- fixture\nconst unused = 1\n`)).toEqual([])
  })
})
