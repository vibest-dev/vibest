import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { cacheKeys, rememberPasses, scenario } from "../src/runner/cache.ts"

const temp = () => fs.mkdtemp(path.join(os.tmpdir(), "vbe-cache-test-"))

describe("cache key", () => {
  test("follows relative imports outside the scenarios folder, recursively", async () => {
    const root = await temp()
    await fs.mkdir(path.join(root, "scenarios"))
    await fs.mkdir(path.join(root, "protocol"))
    await fs.writeFile(path.join(root, "scenarios/exits.ts"), 'import { a } from "../protocol/protocol.ts"\n')
    await fs.writeFile(path.join(root, "protocol/protocol.ts"), 'export * from "./schema.ts"\n')
    await fs.writeFile(path.join(root, "protocol/schema.ts"), "export const a = 1\n")
    const before = await scenario(path.join(root, "scenarios/exits.ts"))
    await fs.writeFile(path.join(root, "protocol/schema.ts"), "export const a = 2\n")
    expect(await scenario(path.join(root, "scenarios/exits.ts"))).not.toBe(before)
  })

  test("hashes a diamond of imports the same every time", async () => {
    const root = await temp()
    await fs.writeFile(path.join(root, "area.ts"), 'import "./a.ts"\nimport "./b.ts"\n')
    await fs.writeFile(path.join(root, "a.ts"), 'import "./shared.ts"\n')
    await fs.writeFile(path.join(root, "b.ts"), 'import "./shared.ts"\n')
    await fs.writeFile(path.join(root, "shared.ts"), 'import "./a.ts"\nexport const s = 1\n')
    const hashes = new Set(await Promise.all(Array.from({ length: 20 }, () => scenario(path.join(root, "area.ts")))))
    expect(hashes.size).toBe(1)
  })

  test("changes when the compiled binary behind a stable launcher changes", async () => {
    const root = await temp()
    const launcher = path.join(root, "vibest.cjs")
    const compiled = path.join(root, "vibest")
    await fs.mkdir(path.join(root, "harnesses"))
    await fs.writeFile(launcher, "launcher")
    await fs.writeFile(compiled, "core 1")
    const key = await cacheKeys({
      login: {},
      binaries: [launcher, compiled],
      harnesses: path.join(root, "harnesses"),
      method: "npm",
      userFiles: {},
    })
    const before = await key("daemon", "D1")
    await fs.writeFile(compiled, "core 2")
    const after = await (
      await cacheKeys({
        login: {},
        binaries: [launcher, compiled],
        harnesses: path.join(root, "harnesses"),
        method: "npm",
        userFiles: {},
      })
    )("daemon", "D1")
    expect(after).not.toBe(before)
  }, 60_000)

  test("a run whose invariants failed caches none of its passes", async () => {
    const into = path.join(await temp(), "cache")
    const passes = [
      { key: "k1", id: "D1" },
      { key: "k2", id: "S1" },
    ]
    await rememberPasses(passes, ["evidence holds a user model, provider or account value: H1.json"], into)
    expect(await fs.readdir(into).catch(() => [])).toEqual([])
    await rememberPasses(passes, [], into)
    expect((await fs.readdir(into)).sort()).toEqual(["k1", "k2"])
  })
})
