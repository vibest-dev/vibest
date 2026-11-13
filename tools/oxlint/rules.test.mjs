import childProcess from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import url from "node:url"

import { describe, expect, it } from "vitest"

const root = url.fileURLToPath(new URL("../..", import.meta.url))

const oxlintFindings = (source) => {
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
      oxlintFindings(`import childProcess from "node:child_process"
import fs from "node:fs"
import fsPromises from "node:fs/promises"
import type { Stats } from "node:fs"
import { type Dirent } from "node:fs"
export type { Stats } from "node:fs"
export { type Stats as FsStats } from "node:fs"
export const all = [childProcess, fs, fsPromises] as unknown as [Stats, Dirent]
`),
    ).toEqual([])
  })

  it("rejects named and namespace imports", () => {
    expect(
      oxlintFindings(`import { readFileSync } from "node:fs"
import * as path from "node:path"
export const all = [readFileSync, path]
`),
    ).toEqual(["1 vibest(node-import-style)", "2 vibest(node-import-style)"])
  })

  it("rejects ad-hoc names, and the short name for a subpath when its parent is imported too", () => {
    expect(
      oxlintFindings(`import nodePath from "node:path"
import fs from "node:fs"
import fsp from "node:fs/promises"
export const all = [nodePath, fs, fsp]
`),
    ).toEqual(["1 vibest(node-import-style)", "3 vibest(node-import-style)"])
  })

  it("rejects re-exports from builtins", () => {
    expect(
      oxlintFindings(`export { readFileSync } from "node:fs"
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
      oxlintFindings(`// oxlint-disable-next-line ${rule}
import os from "os"
export const cpus = os.cpus()
`),
    ).toContain("1 vibest(no-restricted-disable)")
  })

  it.each(["eslint/max-lines", "max-lines", "oxc/max-lines"])(
    "refuses disabling %s on a file over the limit",
    (rule) => {
      const body = Array.from({ length: 1001 }, (_, i) => `export const line${i} = ${i}`).join("\n")
      expect(oxlintFindings(`/* oxlint-disable ${rule} */\n${body}\n`)).toContain("1 vibest(no-restricted-disable)")
    },
  )

  it("refuses a blanket disable", () => {
    expect(oxlintFindings(`// eslint-disable\nexport const one = 1\n`)).toEqual(["1 vibest(no-restricted-disable)"])
  })

  it("allows disabling other rules", () => {
    expect(oxlintFindings(`// oxlint-disable-next-line eslint/no-unused-vars -- fixture\nconst unused = 1\n`)).toEqual(
      [],
    )
  })
})

describe("no-comments", () => {
  it("reports line, block and JSDoc comments", () => {
    expect(
      oxlintFindings(`// a line comment
/* a block comment */
/** a JSDoc comment */
export const one = 1 // a trailing comment
`),
    ).toEqual(["1 vibest(no-comments)", "2 vibest(no-comments)", "3 vibest(no-comments)", "4 vibest(no-comments)"])
  })

  it("allows a shebang, TypeScript directives, triple-slash references and lint directives", () => {
    expect(
      oxlintFindings(`#!/usr/bin/env bun
/// <reference types="node" />
// @ts-expect-error the fixture assigns a number to a string
export const name: string = 1
// @ts-ignore
export const other: string = 2
// oxlint-disable-next-line eslint/no-unused-vars -- fixture
const unused = 1
/* oxlint-disable-next-line eslint/no-unused-vars -- fixture */
const unusedToo = 1
/** @ts-expect-error the fixture assigns a number to a string */
export const third: string = 3
`),
    ).toEqual([])
  })

  it("allows oxlint-enable and eslint-enable directives, with or without rules", () => {
    expect(
      oxlintFindings(`/* oxlint-disable eslint/no-unused-vars */
const unused = 1
/* oxlint-enable eslint/no-unused-vars */
// eslint-disable-next-line eslint/no-unused-vars -- fixture
const unusedToo = 1
// eslint-enable
// oxlint-enable
export const one = 1
`),
    ).toEqual([])
  })

  it("still reports a comment that only mentions a directive", () => {
    expect(oxlintFindings(`// remember to oxlint-enable later\nexport const one = 1\n`)).toEqual([
      "1 vibest(no-comments)",
    ])
  })
})

describe("no-module-let", () => {
  it("reports module-level let, exported or not, and allows let inside functions and const", () => {
    expect(
      oxlintFindings(`let one = 0
export let two = 0
export const three = () => {
  let inner = 0
  inner += 1
  return inner
}
export const bump = () => ++one + two
`),
    ).toEqual(["1 vibest(no-module-let)", "2 vibest(no-module-let)"])
  })
})
