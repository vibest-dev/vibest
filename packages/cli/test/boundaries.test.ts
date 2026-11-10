import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"
import { commands, harnesses, runtimes } from "@vibest/builtins"
import { Effect } from "effect"

const root = path.resolve(import.meta.dirname, "../../..")
const PACKAGES = ["schema", "core", "server", "protocol", "client"]
const HERDR = /["'](effect-herdr-sdk|@vibest\/runtime-herdr)(\/[^"']*)?["']/

const HERDR_TESTS = new Set(["packages/cli/test/guard.test.ts", "packages/cli/test/runtime-herdr.test.ts"])

describe("runtime boundary", () => {
  it("no runtime-neutral package depends on or imports herdr", () => {
    const offenders: Array<string> = []
    for (const name of PACKAGES) {
      const dir = path.join(root, "packages", name)
      const manifest = path.join(dir, "package.json")
      if (HERDR.test(fs.readFileSync(manifest, "utf8"))) offenders.push(path.relative(root, manifest))
      for (const file of fs.readdirSync(path.join(dir, "src"), { recursive: true, encoding: "utf8" })) {
        const full = path.join(dir, "src", file)
        if (/\.tsx?$/.test(file) && HERDR.test(fs.readFileSync(full, "utf8"))) offenders.push(path.relative(root, full))
      }
    }
    assert.deepStrictEqual(offenders, [])
  })

  it("unit tests outside the herdr allowlist do not import effect-herdr-sdk", () => {
    const dir = path.join(root, "packages/cli/test")
    const offenders: Array<string> = []
    for (const file of fs.readdirSync(dir, { encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue
      const rel = path.join("packages/cli/test", file)
      if (HERDR_TESTS.has(rel)) continue
      const text = fs.readFileSync(path.join(dir, file), "utf8")
      const blocks = text.match(/(?:import|export)[\s\S]*?from\s+["'][^"']+["']/g) ?? []
      if (blocks.some((block) => /["']effect-herdr-sdk["']/.test(block))) offenders.push(rel)
    }
    assert.deepStrictEqual(offenders, [])
  })

  it("the CLI does only client work", () => {
    const banned = [
      "projectRoot",
      "createProject",
      "coordinatorCommand",
      "specHits",
      "callerMachine",
      "makeSources",
      "preflight",
      "effect-herdr-sdk",
    ]
    const offenders: Array<string> = []
    const sources = fs
      .readdirSync(path.join(root, "packages/cli/src"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => path.join("packages/cli/src", entry.name))
    for (const rel of sources) {
      const source = fs.readFileSync(path.join(root, rel), "utf8")
      for (const name of banned)
        if (new RegExp("\\b" + name + "\\b").test(source)) offenders.push(`${rel} imports ${name}`)
    }
    assert.deepStrictEqual(offenders, [])
  })

  it("neutral packages do not name a builtin runtime or harness", () => {
    const names = new Set<string>()
    for (const harness of harnesses) {
      names.add(harness.definition.id)
      names.add(harness.definition.binary)
    }
    for (const runtime of runtimes) names.add(runtime.id)
    for (const command of commands(() => Effect.void)) {
      assert.strictEqual(typeof command.name, "string")
      names.add(command.name)
    }
    names.delete("")
    assert.isAbove(names.size, 0)
    const packages = ["core", "server", "cli", "protocol"]
    const offenders: Array<string> = []
    for (const name of packages) {
      const dir = path.join(root, "packages", name, "src")
      for (const file of fs.readdirSync(dir, { recursive: true, encoding: "utf8" })) {
        if (!/\.tsx?$/.test(file)) continue
        const rel = path.join("packages", name, "src", file)
        const source = fs.readFileSync(path.join(root, rel), "utf8")
        for (const literal of stringLiterals(source))
          if (names.has(literal)) offenders.push(`${rel} names ${JSON.stringify(literal)}`)
      }
    }
    assert.deepStrictEqual(offenders, [])
  })
})

const stringLiterals = (source: string): Array<string> => {
  const found: Array<string> = []
  let i = 0
  while (i < source.length) {
    const c = source[i]!
    if (c === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i + 2)
      i = end === -1 ? source.length : end + 1
      continue
    }
    if (c === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end === -1 ? source.length : end + 2
      continue
    }
    if (c !== '"' && c !== "'" && c !== "`") {
      i++
      continue
    }
    const quote = c
    let body = ""
    let closed = false
    i++
    for (; i < source.length; i++) {
      const ch = source[i]!
      if (ch === "\\") {
        const next = source[i + 1]
        if (next === undefined) break
        body += next
        i++
        continue
      }
      if (quote === "`" && ch === "$" && source[i + 1] === "{") {
        closed = false
        break
      }
      if (ch === quote) {
        closed = true
        i++
        break
      }
      body += ch
    }
    if (closed) found.push(body)
  }
  return found
}
