import fs from "node:fs"
import path from "node:path"

// D14: herdr is one Runtime implementation. The packages below reach it only through `@vibest/core/runtime`.
import { assert, describe, it } from "@effect/vitest"

const root = path.resolve(import.meta.dirname, "../../..")
const PACKAGES = ["schema", "core", "server", "protocol", "client"]
const HERDR = /["'](effect-herdr-sdk|@vibest\/runtime-herdr)(\/[^"']*)?["']/

/** May import `effect-herdr-sdk`. Every other unit test uses FakeRuntime. */
const HERDR_TESTS = new Set(["apps/vibest/test/guard.test.ts", "apps/vibest/test/runtime-herdr.test.ts"])

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
    const dir = path.join(root, "apps/vibest/test")
    const offenders: Array<string> = []
    for (const file of fs.readdirSync(dir, { encoding: "utf8" })) {
      if (!file.endsWith(".ts")) continue
      const rel = path.join("apps/vibest/test", file)
      if (HERDR_TESTS.has(rel)) continue
      const text = fs.readFileSync(path.join(dir, file), "utf8")
      const blocks = text.match(/(?:import|export)[\s\S]*?from\s+["'][^"']+["']/g) ?? []
      if (blocks.some((block) => /["']effect-herdr-sdk["']/.test(block))) offenders.push(rel)
    }
    assert.deepStrictEqual(offenders, [])
  })
})
