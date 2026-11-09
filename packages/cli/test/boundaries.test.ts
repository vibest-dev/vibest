import fs from "node:fs"
import path from "node:path"

import { assert, describe, it } from "@effect/vitest"

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
      "callerHits",
      "callerMachine",
      "makeSources",
      "preflight",
      "effect-herdr-sdk",
    ]
    const offenders: Array<string> = []
    for (const rel of [
      "packages/cli/src/cli.ts",
      "packages/cli/src/caller.ts",
      "packages/cli/src/doctor.ts",
      "packages/cli/src/update.ts",
      "packages/cli/src/herdr-plugin.ts",
    ]) {
      const source = fs.readFileSync(path.join(root, rel), "utf8")
      for (const name of banned)
        if (new RegExp("\\b" + name + "\\b").test(source)) offenders.push(`${rel} imports ${name}`)
    }
    assert.deepStrictEqual(offenders, [])
  })
})
